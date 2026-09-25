import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitCategory, fillPrice, fillSamples, calibrateChain, costModelFrom } from "./calibrate";
import { type Candle, GeckoTerminalClient, candleAt, mergePages, parseOhlcvList, stitchSeries } from "./candles";
import { parseArgs, universeFilter } from "./cli";
import { buyImpactPct, liquidityAt, sellImpactPct } from "./costs";
import { atDecision, historyView, survivor, SURVIVOR_DEFAULTS } from "./entries";
import type { SimResult } from "./simulate";
import { bootstrapMeanCI, simulatePortfolio, tradeStats } from "./stats";
import { gasNetOfRent, loadUniverse, parsePrimaryPair, type UniverseCandidate } from "./universe";

const T0 = 1_790_000_000;
const k = (i: number, c: number, d = 60): Candle => ({ t: T0 + i * d, o: c, h: c, l: c, c, v: 1, d });

describe("parseOhlcvList", () => {
  it("merges GeckoTerminal's split rows for one interval in trading order and sorts ascending", () => {
    const rows = [
      [T0 + 60, 5, 6, 5, 6, 10],
      [T0 + 60, 6, 7, 6, 6.5, 2],
      [T0, 4, 5, 3.5, 5, 7],
    ];
    expect(parseOhlcvList(rows)).toEqual([
      { t: T0, o: 4, h: 5, l: 3.5, c: 5, v: 7, d: 60 },
      { t: T0 + 60, o: 5, h: 7, l: 5, c: 6.5, v: 12, d: 60 },
    ]);
  });
  it("drops malformed rows and zero closes", () => {
    expect(parseOhlcvList([[T0, 1, 1, 1, 0, 1], ["x"], null, [T0 + 60, 1, 2, 1, 2, "3"]])).toEqual([{ t: T0 + 60, o: 1, h: 2, l: 1, c: 2, v: 3, d: 60 }]);
    expect(parseOhlcvList(undefined)).toEqual([]);
  });
});

describe("stitchSeries", () => {
  it("prefers 1m inside the 1m window, even across its no-trade gaps, and 5m outside it", () => {
    const fine = [k(10, 1), k(40, 2)];
    const coarse = [k(0, 9, 300), k(1, 9, 300), k(3, 9, 300), k(8, 9, 300), k(9, 9, 300)];
    const out = stitchSeries(fine, coarse, T0 + 300, T0 + 45 * 60);
    expect(out.map((c) => [c.t - T0, c.d])).toEqual([
      [0, 300],
      [600, 60],
      [2400, 60],
      [2700, 300],
    ]);
  });
  it("unions overlapping pages", () => {
    expect(mergePages([[k(0, 1), k(1, 2)], [k(1, 2), k(2, 3)]]).map((c) => c.c)).toEqual([1, 2, 3]);
  });
  it("finds the candle at or before a time", () => {
    const s = [k(0, 1), k(2, 2)];
    expect(candleAt(s, T0 - 1)).toBe(-1);
    expect(candleAt(s, T0 + 90)).toBe(0);
    expect(candleAt(s, T0 + 120)).toBe(1);
  });
});

describe("GeckoTerminalClient", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("caches a closed window forever and serves it offline", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gt-"));
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      calls++;
      expect(url).toContain("/networks/solana/pools/POOL/ohlcv/minute?aggregate=5");
      expect(url).toContain("token=TOKEN");
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[T0, 1, 2, 0.5, 1.5, 9]] } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new GeckoTerminalClient({ cacheDir: dir, fetchImpl, minIntervalMs: 0 });
    const req = { network: "solana", pool: "POOL", token: "TOKEN", timeframe: "5m" as const, beforeTs: T0 };
    expect(await client.ohlcv(req)).toEqual([{ t: T0, o: 1, h: 2, l: 0.5, c: 1.5, v: 9, d: 300 }]);
    expect(await client.ohlcv(req)).toHaveLength(1);
    expect(calls).toBe(1);
    const offline = new GeckoTerminalClient({ cacheDir: dir, offline: true, fetchImpl: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch });
    expect(await offline.ohlcv(req)).toHaveLength(1);
    expect(await offline.ohlcv({ ...req, pool: "OTHER" })).toBeUndefined();
  });

  it("treats an unknown pool (404) as no candles, not a failure", async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "gt-"));
    const client = new GeckoTerminalClient({
      cacheDir: dir,
      minIntervalMs: 0,
      fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch,
    });
    expect(await client.ohlcv({ network: "robinhood", pool: "0xdead", timeframe: "1m", beforeTs: T0 })).toEqual([]);
  });
});

describe("cost model", () => {
  it("prices constant-product impact on the quote reserve", () => {
    expect(buyImpactPct(100, 10_000)).toBeCloseTo(2);
    expect(sellImpactPct(100, 10_000)).toBeCloseTo((1 - 1 / 1.02) * 100);
    expect(buyImpactPct(100, undefined)).toBe(0); // unknown depth (bonding curves): no modeled impact
    expect(buyImpactPct(100, 0)).toBe(100);
  });
  it("scales full-range liquidity with sqrt(price)", () => {
    expect(liquidityAt(20_000, 1, 0.25)).toBeCloseTo(10_000);
    expect(liquidityAt(undefined, 1, 0.25)).toBeUndefined();
  });
});

describe("stats", () => {
  it("bootstraps a deterministic CI around the mean", () => {
    const xs = [-20, -15, -15, -10, 5, 40, 120];
    const [lo, hi] = bootstrapMeanCI(xs, { iterations: 4000, seed: 3 });
    expect(bootstrapMeanCI(xs, { iterations: 4000, seed: 3 })).toEqual([lo, hi]);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(lo).toBeLessThan(m);
    expect(hi).toBeGreaterThan(m);
  });
  it("summarizes wins, losses and profit factor", () => {
    const s = tradeStats([
      { netPct: 50, grossPct: 52, netUsd: 1 },
      { netPct: -10, grossPct: -8, netUsd: -0.2 },
      { netPct: -20, grossPct: -18, netUsd: -0.4 },
    ]);
    expect(s.winRate).toBeCloseTo(1 / 3);
    expect(s.avgWinPct).toBe(50);
    expect(s.avgLossPct).toBe(-15);
    expect(s.profitFactor).toBeCloseTo(50 / 30);
    expect(s.expectancyPct).toBeCloseTo(20 / 3);
    expect(s.totalNetUsd).toBeCloseTo(0.4);
  });

  const simAt = (entryTs: number, exitTs: number, exitMid: number): SimResult => ({
    entryTs,
    entryMid: 1,
    entryFill: 1,
    entryLiquidityUsd: undefined,
    tier: "BASE",
    legs: [{ ts: exitTs, fraction: 1, mid: exitMid, liquidityUsd: undefined, type: "X", reason: "" }],
    peakMultiple: 1,
    troughMultiple: 1,
    exitReason: "",
    holdMinutes: 0,
  });
  const costs = { robinhood: { entrySlippagePct: 0, exitSlippagePct: 0, gasBuyUsd: 0, gasSellUsd: 0 } };

  it("sizes each entry at a percent of equity at that moment, never a fixed dollar amount", () => {
    const p = simulatePortfolio(
      [
        { chain: "robinhood", sim: simAt(T0, T0 + 10, 2) }, // $10 -> $20: equity 110
        { chain: "robinhood", sim: simAt(T0 + 20, T0 + 30, 1) }, // 10% of 110 = $11
      ],
      { startEquityUsd: 100, sizePct: 10, costs }
    );
    expect(p.finalEquityUsd).toBeCloseTo(110);
    expect(p.taken).toBe(2);
    expect(p.curve.find((c) => c.ts === T0 + 20)?.equityUsd).toBeCloseTo(110);
  });
  it("can size by a rule on equity, like the user's brackets", () => {
    const p = simulatePortfolio([{ chain: "robinhood", sim: simAt(T0, T0 + 10, 2) }], { startEquityUsd: 20, sizePct: 0, sizing: (eq) => (eq < 50 ? 0.4 : 0.3), costs });
    expect(p.finalEquityUsd).toBeCloseTo(28); // 40% of $20 doubled
  });
  it("skips entries it can't fund or that exceed the concurrency cap, and tracks drawdown", () => {
    const trades = [0, 1, 2].map((i) => ({ chain: "robinhood", sim: simAt(T0 + i, T0 + 100, 0.5) }));
    const p = simulatePortfolio(trades, { startEquityUsd: 100, sizePct: 50, costs, maxConcurrent: 2 });
    expect(p.taken).toBe(2);
    expect(p.skippedConcurrency).toBe(1);
    expect(p.finalEquityUsd).toBeCloseTo(50);
    expect(p.maxDrawdownPct).toBeCloseTo(50);
  });
});

describe("calibration", () => {
  const candidate = { chain: "robinhood", symbol: "X" } as UniverseCandidate;
  const trade = {
    id: "t1",
    openedAt: T0 + 30,
    entryLiquidityUsd: 20_000,
    executions: [
      { type: "BUY" as const, ts: T0 + 30, tokenAmount: 100, usdValue: 105, actualPrice: null, gasCostUsd: 0.04 },
      { type: "SELL" as const, ts: T0 + 90, tokenAmount: 100, usdValue: 190, actualPrice: null, gasCostUsd: 0.03 },
    ],
  } as unknown as UniverseCandidate["trades"][number];
  const series = { candles: [k(0, 1), k(1, 2)], pools: ["p"], coverageEnd: T0 + 999 };

  it("measures each fill against the candle it landed in, net of modeled impact", () => {
    const [buy, sell] = fillSamples(candidate, trade, series);
    expect(buy.costPct).toBeCloseTo(5);
    expect(buy.impactPct).toBeCloseTo(buyImpactPct(105, 20_000));
    expect(buy.residualPct).toBeCloseTo(5 - buy.impactPct);
    expect(sell.costPct).toBeCloseTo(5); // 1.90 vs 2.00
  });
  it("prefers usdValue / tokenAmount over the recorded price", () => {
    expect(fillPrice({ usdValue: 10, tokenAmount: 4, actualPrice: 9 })).toBe(2.5);
    expect(fillPrice({ usdValue: null, tokenAmount: 4, actualPrice: 9 })).toBe(9);
  });
  const mk = (chain: string, side: "BUY" | "SELL", xs: number[]) =>
    xs.map((r, i) => ({ chain, side, residualPct: r, costPct: r, impactPct: 0, tradeId: `${chain}${side}${i}`, symbol: null, ts: 0, usd: 1, actualPrice: 1, refPrice: 1 }));

  it("builds a median (or p75) cost model per side, floored at zero, with defaults when a side has no fills", () => {
    const cal = calibrateChain(mk("robinhood", "BUY", [1, 2, 3, 4, -8]), [trade]);
    expect(costModelFrom({ robinhood: cal }).robinhood.entrySlippagePct).toBeCloseTo(2);
    expect(costModelFrom({ robinhood: cal }, "p75").robinhood.entrySlippagePct).toBeCloseTo(3);
    expect(costModelFrom({ robinhood: cal }).robinhood.exitSlippagePct).toBe(3); // no sell samples: default
    expect(costModelFrom({ robinhood: cal }).robinhood.gasBuyUsd).toBeCloseTo(0.04);
    expect(costModelFrom({ robinhood: calibrateChain(mk("robinhood", "BUY", [-5, -4, -3]), []) }).robinhood.entrySlippagePct).toBe(0);
  });
  it("lets a chain with few fills borrow the all-chain slippage but keep its own gas", () => {
    const sol = [...mk("solana", "BUY", [-4, -3, -2]), ...mk("solana", "SELL", [1, 2, 3])];
    const all = [...sol, ...mk("robinhood", "BUY", Array(40).fill(2.5)), ...mk("robinhood", "SELL", Array(40).fill(3))];
    const solanaTrade = { ...trade, executions: [{ ...trade.executions[0], gasCostUsd: 0.002 }] } as typeof trade;
    const model = costModelFrom({ solana: calibrateChain(sol, [solanaTrade]), all: calibrateChain(all, [solanaTrade, trade]) });
    expect(model.solana.entrySlippagePct).toBeCloseTo(2.5);
    expect(model.solana.exitSlippagePct).toBeCloseTo(3);
    expect(model.solana.gasBuyUsd).toBeCloseTo(0.002);
  });
  it("buckets live exit reasons", () => {
    expect(exitCategory("loss -23.5% reached max tolerated loss")).toBe("max-loss-stop");
    expect(exitCategory("catastrophic loss -86.8%")).toBe("catastrophic-stop");
    expect(exitCategory("retraced 21.0% from peak 6.01x (trail 12%)")).toBe("trailing");
    expect(exitCategory("written off immediately — wallet cannot transfer")).toBe("write-off");
    expect(exitCategory("AI strategy: The chart shows")).toBe("ai-exit");
    expect(exitCategory("held 60 minutes, exceeds 60min max")).toBe("time");
    expect(exitCategory("liquidity dropped more than 50% since entry")).toBe("liquidity-pull");
  });
});

describe("entries", () => {
  it("only shows a plugin candles that had closed by the time asked", () => {
    const view = historyView([k(0, 1), k(1, 2), k(2, 3)]);
    expect(view(T0 + 119).map((c) => c.c)).toEqual([1]);
    expect(view(T0 + 120).map((c) => c.c)).toEqual([1, 2]);
  });
  it("enters at the decision time plus a delay", () => {
    const c = { createdAt: T0 } as UniverseCandidate;
    expect(atDecision(5).decide({ candidate: c, closedBy: () => [] })).toEqual({ ts: T0 + 300 });
  });
});

describe("survivor entry", () => {
  const H = 3_600;
  const c5 = (t: number, c: number, v = 1_000): Candle => ({ t, o: c, h: c, l: c, c, v, d: 300 });
  // Launch at T0 to 2x, fade to 1.5x, then drift, then break out after the 6h check.
  const path = (breakAt: number | undefined) => {
    const out: Candle[] = [c5(T0, 1), c5(T0 + 600, 2)];
    for (let t = T0 + H; t < T0 + 6 * H; t += 300) out.push(c5(t, 1.5));
    for (let t = T0 + 6 * H; t < T0 + 12 * H; t += 300) out.push(c5(t, breakAt !== undefined && t >= breakAt ? 1.8 : 1.5));
    return out;
  };
  const cand = { createdAt: T0 + 60 } as UniverseCandidate;
  const params = { ...SURVIVOR_DEFAULTS, checkHours: 6, minFractionOfPeak: 0.7, minVolumeUsd: 5_000 };

  it("enters at the close of the first candle that breaks the pre-check range", () => {
    const candles = path(T0 + 7 * H);
    expect(survivor(params).decide({ candidate: cand, closedBy: historyView(candles) })).toEqual({ ts: T0 + 7 * H + 300, note: "broke 1.500" });
  });
  it("skips tokens that faded too far from their peak, went quiet, lost volume, or never broke out", () => {
    const candles = path(T0 + 7 * H);
    const decide = (over: Partial<typeof params>, cs = candles) => survivor({ ...params, ...over }).decide({ candidate: cand, closedBy: historyView(cs) });
    expect(decide({ minFractionOfPeak: 0.8 })).toEqual({ skip: "too far below its peak" });
    expect(decide({ minVolumeUsd: 1e9 })).toEqual({ skip: "volume faded" });
    expect(decide({}, path(undefined))).toEqual({ skip: "no breakout" });
    expect(decide({}, candles.filter((c) => c.t < T0 + 4 * H))).toEqual({ skip: "pool quiet at the check" });
    const collapsed = candles.map((c) => (c.t >= T0 + H ? { ...c, c: 0.15 } : c));
    expect(decide({ minFractionOfPeak: 0 }, collapsed)).toEqual({ skip: "collapsed since detection" });
  });
  it("can't see the breakout candle before it has closed", () => {
    const candles = path(T0 + 7 * H);
    const upToCheck = candles.filter((c) => c.t + c.d <= T0 + 6 * H);
    // Same history up to the check, different future: the pre-check decision inputs are identical.
    expect(survivor(params).decide({ candidate: cand, closedBy: historyView(upToCheck) })).toEqual({ skip: "no breakout" });
  });
});

describe("cli", () => {
  it("parses commands and flags", () => {
    expect(parseArgs(["run", "--chain", "solana", "--legacy-steps", "--size-pct=5"])).toEqual({
      command: "run",
      flags: { chain: "solana", "legacy-steps": true, "size-pct": "5" },
    });
  });
  it("filters the universe, leaving out manual buy-and-holds unless asked", () => {
    const c = (o: Partial<UniverseCandidate>) => ({ chain: "robinhood", status: "REJECTED", createdAt: T0, qualificationPath: "NORMAL", ...o }) as UniverseCandidate;
    const f = universeFilter({ chain: "robinhood", status: "REJECTED,TRADED", from: new Date(T0 * 1000).toISOString() });
    expect(f(c({}))).toBe(true);
    expect(f(c({ chain: "solana" }))).toBe(false);
    expect(f(c({ status: "EXPIRED" }))).toBe(false);
    expect(f(c({ createdAt: T0 - 1 }))).toBe(false);
    expect(f(c({ qualificationPath: "MANUAL_BUY_AND_HOLD" }))).toBe(false);
    expect(universeFilter({ "include-manual": true })(c({ qualificationPath: "MANUAL_BUY_AND_HOLD" }))).toBe(true);
    const sol = (tokenAddress: string, dexId: string) => c({ chain: "solana", tokenAddress, pair: { pairAddress: "p", dexId } });
    expect(universeFilter({ venue: "other" })(sol("Xpump", "raydium"))).toBe(false);
    expect(universeFilter({ venue: "other" })(sol("X", "raydium"))).toBe(true);
    expect(universeFilter({ venue: "pump.fun" })(sol("Xpump", "pumpswap"))).toBe(true);
  });
});

describe("universe", () => {
  it("parses a DexScreener primaryPair", () => {
    expect(parsePrimaryPair({ pairAddress: "0xabc", dexId: "uniswap", priceUsd: "0.5", liquidityUsd: 100 })).toMatchObject({
      pairAddress: "0xabc",
      dexId: "uniswap",
      priceUsd: 0.5,
      liquidityUsd: 100,
    });
    expect(parsePrimaryPair(null)).toBeNull();
    expect(parsePrimaryPair({ dexId: "x" })).toBeNull();
  });

  it("leaves refundable Solana token-account rent out of gas", () => {
    expect(gasNetOfRent(0.4, 5_000, 1_995_000)).toBeCloseTo(0.001);
    expect(gasNetOfRent(0.04, null, null)).toBe(0.04);
  });

  it("assembles candidates, their trades and fills from read-only queries", async () => {
    const queries: string[] = [];
    const answers: Record<string, unknown>[][] = [
      [{ id: "c1", tokenId: "tok", chain: "solana", address: "A", symbol: "S", status: "TRADED", created_at: T0, first_seen: T0 - 60, pp: { pairAddress: "P" }, traded: true }],
      [{ id: "t1", candidateId: "c1", mode: "LIVE", status: "CLOSED", positionSizeUsd: 3, opened_at: T0 + 10, strategyVersionId: "v" }],
      [{ tradeId: "t1", type: "BUY", ts: T0 + 10, tokenAmount: 5, usdValue: 3, actualPrice: 0.6, gasCostUsd: 0.01 }],
      [{ tradeId: "t1", ts: T0 + 15, priceUsd: 0.55 }],
      [{ id: "v", version: "v1.8", status: "PRODUCTION", created_at: T0, exitRules: { maxLossPercent: 15 } }],
    ];
    const snap = await loadUniverse(async (sql) => {
      queries.push(sql);
      return answers[queries.length - 1];
    });
    expect(queries.every((q) => /^\s*select/i.test(q))).toBe(true);
    expect(snap.candidates).toHaveLength(1);
    expect(snap.candidates[0].pair?.pairAddress).toBe("P");
    expect(snap.candidates[0].trades[0]).toMatchObject({ id: "t1", openedAt: T0 + 10, firstMark: { ts: T0 + 15, priceUsd: 0.55 } });
    expect(snap.candidates[0].trades[0].executions).toHaveLength(1);
    expect(snap.strategyVersions[0].exitRules.maxLossPercent).toBe(15);
  });
});
