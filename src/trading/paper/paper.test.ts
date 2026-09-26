import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExitRules } from "../strategy";
import { evaluatePaperMark, isPumpLaunch, markDue, TickQuoteCache } from "./engine";
import { QuoteBudget } from "./quoteBudget";
import { inferDecimals, paperBuyQuote, paperSellQuote } from "./quotes";
import { USER_BRACKETS, parseEntry, parseFilter, parseSizing, sizingFraction } from "./strategyConfig";

const { getJupiterQuote } = vi.hoisted(() => ({ getJupiterQuote: vi.fn() }));
vi.mock("../live/solana/jupiterClient", () => ({ SOL_MINT: "SOL", getJupiterQuote: (...args: unknown[]) => getJupiterQuote(...args) }));
vi.mock("../portfolio", () => ({ getCachedSolPriceUsd: () => 200 }));

const v18: ExitRules = {
  profitSteps: [{ multiple: 2, sellPercentOfRemaining: 50 }],
  trailRemaining: true,
  trailingActivationMultiple: 1.6,
  trailingPercent: 20,
  maxLossPercent: 15,
  catastrophicLossPercent: 25,
  maxHoldMinutes: 1440,
};
const v19: ExitRules = { ...v18, costRecovery: { triggerMultiple: 2, sellCostBufferPercent: 3, moonbagTrailingPercent: 45 } };

const openedAt = new Date("2026-09-25T12:00:00Z");
const state = (over: Partial<Parameters<typeof evaluatePaperMark>[0]["state"]> = {}) => ({
  sizeUsd: 10,
  costBasisUsd: 10.01,
  realizedProceedsUsd: 0,
  tokensRemainingRaw: 1_000_000_000n, // 1000 tokens at 6 decimals
  decimals: 6,
  entryPriceUsd: 0.01,
  firstMarkPriceUsd: 0.0095,
  mfePercent: 0,
  maePercent: 0,
  openedAt,
  meta: { qualityScore: 70, socialScore: null, tradeLane: "MOMENTUM_TACTICAL", supply: 1e9, liquidityUsdAtDecision: 30_000, pairPriceUsd: 0.0098 },
  ...over,
});
const mark = (quoteUsd: number, over: Partial<Parameters<typeof evaluatePaperMark>[0]> = {}) =>
  evaluatePaperMark({ state: state(), quoteUsd, now: new Date(openedAt.getTime() + 10 * 60_000), exitRules: v18, gasSellUsd: 0.014, maxHoldHours: 48, ...over });

describe("evaluatePaperMark through the live evaluateExits", () => {
  it("confirms a stop only after the mark has stayed past it 30s under stopConfirm", () => {
    const s1: ExitRules = { ...v18, stopConfirm: { seconds: 30, appliesTo: "maxLoss" } };
    const t0 = new Date(openedAt.getTime() + 10 * 60_000);
    const first = mark(7.9, { exitRules: s1, now: t0 });
    expect(first.sell).toBeUndefined();
    expect(first.stopBreachSinceMs).toBe(t0.getTime());
    const held = mark(7.9, { exitRules: s1, now: new Date(t0.getTime() + 30_000), stopBreachSinceMs: first.stopBreachSinceMs });
    expect(held.sell).toMatchObject({ type: "RISK_EXIT", closes: true });
    const recovered = mark(9, { exitRules: s1, now: new Date(t0.getTime() + 20_000), stopBreachSinceMs: first.stopBreachSinceMs });
    expect(recovered.stopBreachSinceMs).toBeUndefined();
  });

  it("holds a small dip and stops out past -15% from the first mark", () => {
    expect(mark(9).sell).toBeUndefined();
    const stop = mark(7.9); // 0.0079 vs a 0.0095 first mark: -16.8%
    expect(stop.sell).toMatchObject({ raw: 1_000_000_000n, closes: true, type: "RISK_EXIT" });
    expect(stop.sell!.proceedsUsd).toBeCloseTo(7.9);
  });

  it("trails from the peak under v1.8", () => {
    const r = mark(17, { state: state({ mfePercent: 120 }) }); // 1.7x now, 2.2x peak: 22.7% retrace
    expect(r.sell?.type).toBe("TRAILING_EXIT");
    expect(r.mfePercent).toBe(120);
  });

  it("sells just enough at 2x to recover cost under v1.9, priced pro rata from the full-size quote", () => {
    const r = mark(21, { exitRules: v19 }); // 2.1x
    expect(r.sell?.type).toBe("PARTIAL_PROFIT");
    expect(r.sell!.closes).toBe(false);
    const share = Number(r.sell!.raw) / 1e9;
    expect(share).toBeGreaterThan(0.45);
    expect(share).toBeLessThan(0.55);
    expect(r.sell!.proceedsUsd).toBeCloseTo(21 * share, 6);
  });

  it("closes at the mark once the paper hold window is over", () => {
    const r = mark(12, { now: new Date(openedAt.getTime() + 49 * 3_600_000) });
    expect(r.sell).toMatchObject({ type: "TIME_EXIT", closes: true });
  });

  it("takes its first mark as the stop baseline", () => {
    expect(mark(9.6, { state: state({ firstMarkPriceUsd: null }) }).firstMarkPriceUsd).toBeCloseTo(0.0096);
  });
});

describe("strategy config", () => {
  it("parses entries, filters and sizing defensively", () => {
    expect(parseEntry({ type: "at-decision" })).toEqual({ type: "at-decision" });
    expect(parseEntry({ type: "survivor" })).toHaveProperty("error");
    expect(parseFilter({ venue: "other" })).toEqual({ venue: "other" });
    expect(parseFilter({ venue: "x" })).toEqual({});
    expect(parseSizing({ type: "flat", pct: 5 })).toEqual({ type: "flat", pct: 5 });
    expect(parseSizing({ type: "flat", pct: 500 })).toHaveProperty("error");
    expect(parseSizing(USER_BRACKETS)).toEqual(USER_BRACKETS);
  });
  it("sizes by the user's brackets, a percent of equity", () => {
    expect(sizingFraction(USER_BRACKETS, 21)).toBe(0.4);
    expect(sizingFraction(USER_BRACKETS, 120)).toBe(0.2);
    expect(sizingFraction(USER_BRACKETS, 5_000)).toBe(0.05);
  });
  it("counts graduated pump.fun mints as pump.fun launches", () => {
    expect(isPumpLaunch("Abcpump", "raydium")).toBe(true);
    expect(isPumpLaunch("Abc", "pumpswap")).toBe(true);
    expect(isPumpLaunch("Abc", "raydium")).toBe(false);
  });
});

describe("quotes", () => {
  beforeEach(() => getJupiterQuote.mockReset());

  it("asks Jupiter at low priority and converts through the cached SOL price", async () => {
    getJupiterQuote.mockResolvedValue({ inAmount: 50_000_000n, outAmount: 12_345n });
    expect(await paperBuyQuote("MINT", 10)).toEqual({ usd: 10, tokensRaw: 12_345n });
    expect(getJupiterQuote).toHaveBeenCalledWith("SOL", "MINT", 50_000_000n, expect.any(Number), undefined, "low");
    getJupiterQuote.mockResolvedValue({ inAmount: 12_345n, outAmount: 25_000_000n });
    expect(await paperSellQuote("MINT", 12_345n)).toEqual({ usd: 5, tokensRaw: 12_345n });
    expect(getJupiterQuote).toHaveBeenLastCalledWith("MINT", "SOL", 12_345n, expect.any(Number), undefined, "low");
  });
  it("reports a missing route instead of guessing a price", async () => {
    getJupiterQuote.mockResolvedValue(undefined);
    expect(await paperSellQuote("MINT", 1n)).toEqual({ unavailable: "no-route" });
  });
  it("infers decimals from the quote against the pair price", () => {
    expect(inferDecimals(0.00001 / 1e6, 0.00001, "X")).toBe(6);
    expect(inferDecimals(2e-9, 2, "X")).toBe(9);
    expect(inferDecimals(1, undefined, "Xpump")).toBe(6);
    expect(inferDecimals(1, undefined, "X")).toBeUndefined();
  });
});

describe("quote economy", () => {
  it("marks every tick for the first hour, then every 2 and 5 minutes", () => {
    const t = (min: number) => new Date(openedAt.getTime() + min * 60_000);
    expect(markDue(openedAt, null, t(0))).toBe(true);
    expect(markDue(openedAt, t(59), t(59.5))).toBe(true);
    expect(markDue(openedAt, t(90), t(91))).toBe(false);
    expect(markDue(openedAt, t(90), t(92))).toBe(true);
    expect(markDue(openedAt, t(400), t(404))).toBe(false);
    expect(markDue(openedAt, t(400), t(405))).toBe(true);
  });
  it("shares one quote per token per tick, re-quoting only for a bigger holding", async () => {
    const quote = vi.fn(async (_mint: string, raw: bigint) => ({ usd: Number(raw) / 100, tokensRaw: raw }));
    const cache = new TickQuoteCache();
    expect(await cache.sell("M", 1_000n, quote)).toEqual({ usd: 10, tokensRaw: 1_000n });
    expect(await cache.sell("M", 500n, quote)).toEqual({ usd: 5, tokensRaw: 500n });
    expect(quote).toHaveBeenCalledTimes(1);
    await cache.sell("M", 2_000n, quote);
    expect(quote).toHaveBeenCalledTimes(2);
  });
});

describe("QuoteBudget", () => {
  it("caps quotes per UTC day and resets at midnight", () => {
    let now = new Date("2026-09-25T23:59:00Z");
    const b = new QuoteBudget(2, () => now);
    expect([b.tryConsume(), b.tryConsume(), b.tryConsume()]).toEqual([true, true, false]);
    now = new Date("2026-09-26T00:00:01Z");
    expect(b.tryConsume()).toBe(true);
    expect(b.usedToday).toBe(1);
  });
});

describe("paper module safety", () => {
  const dir = __dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ f, src: readFileSync(path.join(dir, f), "utf8") }));

  it("never references anything that signs, sends or executes a trade", () => {
    const forbidden = [
      "executeBuyFill",
      "executeSellFill",
      "signAndSendSolanaTransaction",
      "closeTokenAccountAfterFullExit",
      "getJupiterSwapTransaction",
      "executionFacade",
      "executionProvider",
      "/wallet",
      "recordExecutionQuality",
      "getBuyEstimate",
      "getSellEstimate",
    ];
    for (const { f, src } of sources) for (const word of forbidden) expect(src.includes(word), `${f} mentions ${word}`).toBe(false);
  });

  it("never writes live trading tables", () => {
    for (const { f, src } of sources) {
      expect(/\b(db|tx)\.(trade|tradeExecution|ledgerEntry|portfolioSnapshot|exitSignal|positionSnapshot|executionQualityStat)\b/.test(src), f).toBe(false);
    }
  });

  it("only makes Solana quotes through Jupiter (no RPC connection)", () => {
    for (const { f, src } of sources) expect(/Connection|RPC_URL|rpcUrl|@solana\/web3/.test(src), f).toBe(false);
  });
});
