import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExitRules } from "../trading/strategy";
import { type ChainCalibration, MIN_CHAIN_FILLS, calibrateChain, costModelFrom, exitCategory, type FillSample, fillSamples } from "./calibrate";
import { GeckoTerminalClient } from "./candles";
import { type CostModel, DEFAULT_COSTS } from "./costs";
import { atActualEntry, atDecision, type EntryStrategy } from "./entries";
import { type PriceSeries, loadPriceSeries } from "./marketData";
import { chainReports, curveSample, formatChainReports, num, pct, table, usd } from "./report";
import { type RunConfig, type RunRow, runStrategy } from "./run";
import type { IntrabarMode } from "./simulate";
import { mean, mulberry32 } from "./stats";
import { type UniverseCandidate, type UniverseSnapshot, loadUniverse, readSnapshot, saveSnapshot, withReadOnlyProdQuery } from "./universe";

export const REPO_ROOT = path.resolve(__dirname, "../..");
export const CACHE_DIR = process.env.BACKTEST_CACHE_DIR ?? path.join(REPO_ROOT, "data", "backtest-cache");
export const OUT_DIR = process.env.BACKTEST_OUT_DIR ?? path.join(REPO_ROOT, "data", "backtest-out");
export const SNAPSHOT_FILE = path.join(CACHE_DIR, "universe.json");
export const COSTS_FILE = path.join(CACHE_DIR, "costs.json");

// e68e245 removed the deterministic PROFIT_TARGET ladder from evaluateExits
// (committed 2026-09-22 08:17 UTC). Trades opened before it ran the ladder.
export const LADDER_REMOVED_TS = Date.parse("2026-09-22T08:17:57Z") / 1000;

export interface CliArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): CliArgs {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) flags[arg.slice(2)] = rest[++i];
    else flags[arg.slice(2)] = true;
  }
  return { command, flags };
}

export function geckoClient(offline = false): GeckoTerminalClient {
  return new GeckoTerminalClient({
    cacheDir: path.join(CACHE_DIR, "gt"),
    offline,
    log: (m) => console.error(`[gt] ${m}`),
  });
}

export async function getSnapshot(refresh: boolean): Promise<UniverseSnapshot> {
  if (!refresh) {
    try {
      return await readSnapshot(SNAPSHOT_FILE);
    } catch {
      // fall through to a fresh read
    }
  }
  console.error("reading universe from the production DB (read-only)...");
  const snapshot = await withReadOnlyProdQuery(loadUniverse);
  await saveSnapshot(SNAPSHOT_FILE, snapshot);
  console.error(`saved ${snapshot.candidates.length} candidates to ${SNAPSHOT_FILE}`);
  return snapshot;
}

async function fetchAll(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const client = geckoClient();
  // Traded first (they calibrate the fill model), then Solana, then Robinhood,
  // each in a seeded random order so a partly fetched universe is still an
  // unbiased sample of it.
  const rank = (c: UniverseCandidate) => (c.trades.length > 0 ? 0 : c.chain === "solana" ? 1 : 2);
  const rand = mulberry32(20260925);
  const shuffled = snapshot.candidates.map((c) => ({ c, r: rand() }));
  const ordered = shuffled.sort((a, b) => rank(a.c) - rank(b.c) || a.r - b.r).map((x) => x.c);
  const list = flags["only-traded"] ? ordered.filter((c) => c.trades.length > 0) : ordered;
  // Pass "fine": 1m everywhere (and 5m for traded); pass "coarse": 5m everywhere.
  const pass = flags.pass === "coarse" ? "coarse" : "fine";
  let done = 0;
  let missing = 0;
  const started = Date.now();
  for (const c of list) {
    const want = pass === "fine" ? { fine: true, coarse: c.trades.length > 0 } : { fine: false, coarse: true };
    const series = await loadPriceSeries(client, c, want).catch((err) => {
      console.error(`[fetch] ${c.symbol} ${c.candidateId}: ${String(err)}`);
      return undefined;
    });
    if (!series || series.candles.length === 0) missing++;
    done++;
    if (done % 25 === 0 || done === list.length) {
      const mins = (Date.now() - started) / 60_000;
      console.error(
        `[fetch] ${new Date().toISOString().slice(11, 19)} ${pass} pass ${done}/${list.length} candidates, ${missing} without candles, ${client.requests} requests, ${client.cacheHits} cache hits, ${mins.toFixed(1)} min`
      );
    }
  }
}

function seriesLoader(client: GeckoTerminalClient): (c: UniverseCandidate) => Promise<PriceSeries | undefined> {
  const memo = new Map<string, Promise<PriceSeries | undefined>>();
  return (c) => {
    const key = `${c.candidateId}:${c.trades.map((t) => t.id).join(",")}`;
    if (!memo.has(key)) memo.set(key, loadPriceSeries(client, c, { fine: true }));
    return memo.get(key)!;
  };
}

export function findExitRules(snapshot: UniverseSnapshot, version: string): ExitRules {
  const match = snapshot.strategyVersions
    .filter((v) => v.version === version || v.version.startsWith(`${version}-`))
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!match) throw new Error(`no StrategyVersion matching ${version}; have ${snapshot.strategyVersions.map((v) => v.version).join(", ")}`);
  return match.exitRules;
}

async function loadExitRules(snapshot: UniverseSnapshot, flags: CliArgs["flags"], key = "exit"): Promise<{ name: string; rules: ExitRules }> {
  const json = flags[`${key}-json`];
  if (typeof json === "string") return { name: path.basename(json, ".json"), rules: JSON.parse(await readFile(json, "utf8")) as ExitRules };
  const version = typeof flags[key] === "string" ? (flags[key] as string) : "v1.8";
  return { name: version, rules: findExitRules(snapshot, version) };
}

interface SavedCosts {
  calibration: Record<string, ChainCalibration>;
}

export async function loadCosts(pick: "median" | "p75" = "median"): Promise<{ model: CostModel; calibrated: boolean }> {
  try {
    const saved = JSON.parse(await readFile(COSTS_FILE, "utf8")) as SavedCosts;
    return { model: costModelFrom(saved.calibration, pick), calibrated: true };
  } catch {
    return { model: DEFAULT_COSTS, calibrated: false };
  }
}

function costsTable(model: CostModel): string {
  return table(
    ["chain", "entry slippage", "exit slippage", "gas per buy", "gas per sell"],
    Object.entries(model).map(([chain, m]) => [chain, pct(m.entrySlippagePct, 2), pct(m.exitSlippagePct, 2), usd(m.gasBuyUsd, 4), usd(m.gasSellUsd, 4)])
  );
}

async function writeOut(name: string, body: unknown): Promise<string> {
  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  await writeFile(file, JSON.stringify(body, null, 1));
  return file;
}

/** One pseudo-candidate per real trade, so a candidate traded twice replays both. */
function perTrade(snapshot: UniverseSnapshot, filter: (c: UniverseCandidate) => boolean): UniverseCandidate[] {
  return snapshot.candidates.filter(filter).flatMap((c) => c.trades.map((t) => ({ ...c, trades: [t] })));
}

async function calibrateCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const getSeries = seriesLoader(geckoClient(true));
  const pick = flags.costs === "p75" ? "p75" : "median";
  const all = perTrade(snapshot, (c) => c.trades.length > 0);

  // 1. What our real swaps cost against the candle reference.
  const samples: FillSample[] = [];
  let noCandles = 0;
  for (const c of all) {
    const series = await getSeries(c);
    if (!series?.candles.length) {
      noCandles++;
      continue;
    }
    samples.push(...fillSamples(c, c.trades[0], series));
  }
  const calibration: Record<string, ChainCalibration> = {};
  for (const chain of [...new Set(all.map((c) => c.chain))]) {
    calibration[chain] = calibrateChain(
      samples.filter((s) => s.chain === chain),
      all.filter((c) => c.chain === chain).map((c) => c.trades[0])
    );
  }
  calibration.all = calibrateChain(samples, all.map((c) => c.trades[0]));
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(COSTS_FILE, JSON.stringify({ calibration, samples }, null, 1));
  const model = costModelFrom(calibration, pick);

  const out: string[] = ["## Fill-cost calibration", ""];
  out.push(`${all.length} real trades, ${noCandles} without candles, ${samples.length} fills measured against the candle price at fill time.`, "");
  out.push(
    table(
      ["chain", "side", "n", "p25", "median", "p75", "mean"],
      Object.entries(calibration).flatMap(([chain, cal]) =>
        (["buy", "sell"] as const).map((sideKey) => {
          const sc = cal[sideKey];
          return [chain, sideKey, sc.n, pct(sc.p25, 2), pct(sc.median, 2), pct(sc.p75, 2), pct(sc.mean, 2)];
        })
      )
    )
  );
  out.push("", "Cost = buy premium over / sell discount under the candle price, minus modeled constant-product impact.", "");
  out.push(
    table(
      ["chain", "first mark vs entry fill (n, median, p25..p75)", "gas/buy mean (median)", "gas/sell mean (median)"],
      Object.entries(calibration).map(([chain, cal]) => [
        chain,
        `${cal.firstMarkPct.n}, ${pct(cal.firstMarkPct.median, 2)}, ${pct(cal.firstMarkPct.p25, 1)}..${pct(cal.firstMarkPct.p75, 1)}`,
        `${usd(cal.gasBuyUsd.mean, 4)} (${usd(cal.gasBuyUsd.median, 4)})`,
        `${usd(cal.gasSellUsd.mean, 4)} (${usd(cal.gasSellUsd.median, 4)})`,
      ])
    )
  );
  out.push(
    "",
    `Cost model used from here on (${pick} of measured cost, floored at 0; chains with under ${MIN_CHAIN_FILLS} fills per side use all-chain slippage; gas at the per-chain mean):`,
    "",
    costsTable(model),
    ""
  );

  // 2. Replay the autonomous live trades, under both intrabar modes.
  const v18 = findExitRules(snapshot, "v1.8");
  const byId = new Map(snapshot.strategyVersions.map((v) => [v.id, v]));
  const auto = all.filter((c) => c.qualificationPath !== "MANUAL_BUY_AND_HOLD" && c.trades[0].mode === "LIVE");
  const actualSize = (c: UniverseCandidate) => c.trades[0].positionSizeUsd;
  const actualPnl = (c: UniverseCandidate) => c.trades[0].realizedPnlUsd ?? 0;
  const variants: { key: string; mode: IntrabarMode; label: string; rows: RunRow[] }[] = [];
  for (const mode of ["worst", "close"] as const) {
    const run = async (key: string, label: string, cfg: Pick<RunConfig, "exitRules" | "legacyProfitSteps" | "useActualEntryFill">) => {
      const rows = await runStrategy(auto, getSeries, { name: key, entry: atActualEntry(), costs: model, refSizeUsd: 3, sizeFor: actualSize, intrabar: mode, ...cfg });
      variants.push({ key, mode, label, rows });
    };
    await run("as-was", "own StrategyVersion, ladder before 09-22, real entry fill", {
      exitRules: (c) => byId.get(c.trades[0].strategyVersionId)?.exitRules ?? v18,
      legacyProfitSteps: (c) => (c.trades[0].openedAt ?? 0) < LADDER_REMOVED_TS,
      useActualEntryFill: true,
    });
    await run("v1.8-real-fill", "v1.8 exits, real entry fill", { exitRules: () => v18, useActualEntryFill: true });
    await run("v1.8-modeled", "v1.8 exits, modeled entry fill", { exitRules: () => v18 });
  }

  const simulatedIds = new Set(variants[0].rows.filter((r) => r.valued).map((r) => r.candidate.trades[0].id));
  const covered = auto.filter((c) => simulatedIds.has(c.trades[0].id));
  const actualAll = auto.reduce((a, c) => a + actualPnl(c), 0);
  out.push("## Replay of our autonomous live trades", "");
  out.push(
    `${auto.length} autonomous live trades, booked P&L ${usd(actualAll)}. ${covered.length} have candles; their booked P&L is ${usd(covered.reduce((a, c) => a + actualPnl(c), 0))}. Each trade is replayed at its real size.`,
    ""
  );
  const summarize = (rows: RunRow[]) => {
    const done = rows.filter((r) => r.valued);
    const sim = done.reduce((a, r) => a + r.valued!.netUsd, 0);
    const act = done.reduce((a, r) => a + actualPnl(r.candidate), 0);
    const sameExit = done.filter((r) => exitCategory(r.sim!.exitReason) === exitCategory(r.candidate.trades[0].exitReason)).length;
    return { done, sim, act, sameExit };
  };
  out.push(
    table(
      ["variant", "intrabar", "n", "sim P&L", "actual P&L", "gap", "sim win rate", "actual win rate", "mean |gap|/trade", "same exit type"],
      variants.map((v) => {
        const { done, sim, act, sameExit } = summarize(v.rows);
        return [
          `${v.key}: ${v.label}`,
          v.mode,
          done.length,
          usd(sim),
          usd(act),
          usd(sim - act),
          pct((done.filter((r) => r.valued!.netUsd > 0).length / done.length) * 100, 0),
          pct((done.filter((r) => actualPnl(r.candidate) > 0).length / done.length) * 100, 0),
          usd(mean(done.map((r) => Math.abs(r.valued!.netUsd - actualPnl(r.candidate)))), 3),
          `${sameExit}/${done.length}`,
        ];
      })
    )
  );

  // Before 09-12 live marked positions with DexScreener's (laggy) price; from
  // then on with an on-chain sell quote every ~5s. The replay should track
  // the later era more closely.
  const MARK_SWITCH_TS = Date.parse("2026-09-12T12:00:00Z") / 1000;
  out.push("", "As-was replay by monitor era (DexScreener marks before 09-12, sell-quote marks after):", "");
  out.push(
    table(
      ["era", "intrabar", "n", "sim P&L", "actual P&L", "gap", "same exit type"],
      variants
        .filter((v) => v.key === "as-was")
        .flatMap((v) =>
          (["before 09-12", "09-12 on"] as const).map((era) => {
            const rows = v.rows.filter((r) => ((r.candidate.trades[0].openedAt ?? 0) < MARK_SWITCH_TS) === (era === "before 09-12"));
            const { done, sim, act, sameExit } = summarize(rows);
            return [era, v.mode, done.length, usd(sim), usd(act), usd(sim - act), `${sameExit}/${done.length}`];
          })
        )
    )
  );

  for (const v of variants.filter((x) => x.key === "as-was")) {
    const byCat = new Map<string, { n: number; actual: number; sim: number; sameCat: number }>();
    for (const r of v.rows.filter((x) => x.valued)) {
      const cat = exitCategory(r.candidate.trades[0].exitReason);
      const e = byCat.get(cat) ?? { n: 0, actual: 0, sim: 0, sameCat: 0 };
      e.n++;
      e.actual += actualPnl(r.candidate);
      e.sim += r.valued!.netUsd;
      if (exitCategory(r.sim!.exitReason) === cat) e.sameCat++;
      byCat.set(cat, e);
    }
    out.push("", `As-was replay (${v.mode}) vs reality, by how the live trade actually exited:`, "");
    out.push(
      table(
        ["live exit", "n", "actual P&L", "sim P&L", "gap", "sim exited the same way"],
        [...byCat.entries()]
          .sort((a, b) => a[1].actual - a[1].sim - (b[1].actual - b[1].sim))
          .map(([cat, e]) => [cat, e.n, usd(e.actual), usd(e.sim), usd(e.sim - e.actual), `${e.sameCat}/${e.n}`])
      )
    );
  }

  const cell = (key: string, mode: IntrabarMode, tradeId: string) =>
    variants.find((v) => v.key === key && v.mode === mode)!.rows.find((r) => r.candidate.trades[0].id === tradeId);
  const perTradeRows = auto.map((c) => {
    const t = c.trades[0];
    const w = cell("as-was", "worst", t.id);
    const cl = cell("as-was", "close", t.id);
    const v = cell("v1.8-real-fill", "worst", t.id);
    return {
      tradeId: t.id,
      symbol: c.symbol,
      chain: c.chain,
      openedAt: new Date((t.openedAt ?? 0) * 1000).toISOString(),
      strategyVersion: byId.get(t.strategyVersionId)?.version,
      sizeUsd: t.positionSizeUsd,
      actualPnlUsd: actualPnl(c),
      actualExit: t.exitReason,
      liveMfePct: t.mfePercent,
      asWasWorstPnlUsd: w?.valued?.netUsd,
      asWasWorstExit: w?.sim?.exitReason ?? w?.skip,
      asWasClosePnlUsd: cl?.valued?.netUsd,
      asWasCloseExit: cl?.sim?.exitReason ?? cl?.skip,
      simPeak: w?.sim?.peakMultiple,
      v18WorstPnlUsd: v?.valued?.netUsd,
      v18WorstExit: v?.sim?.exitReason ?? v?.skip,
    };
  });
  const worst = [...perTradeRows]
    .filter((r) => r.asWasWorstPnlUsd !== undefined)
    .sort((x, y) => Math.abs(y.asWasWorstPnlUsd! - y.actualPnlUsd) - Math.abs(x.asWasWorstPnlUsd! - x.actualPnlUsd))
    .slice(0, 15);
  out.push("", "Largest per-trade gaps (as-was, worst intrabar) vs actual:", "");
  out.push(
    table(
      ["symbol", "opened", "actual", "actual exit", "sim worst", "sim worst exit", "sim close", "live peak", "sim peak"],
      worst.map((r) => [
        r.symbol ?? "?",
        r.openedAt.slice(5, 16),
        usd(r.actualPnlUsd),
        (r.actualExit ?? "").slice(0, 34),
        usd(r.asWasWorstPnlUsd!),
        (r.asWasWorstExit ?? "").slice(0, 34),
        r.asWasClosePnlUsd !== undefined ? usd(r.asWasClosePnlUsd) : "-",
        r.liveMfePct != null ? `${num(1 + r.liveMfePct / 100)}x` : "?",
        r.simPeak ? `${num(r.simPeak)}x` : "?",
      ])
    )
  );
  const file = await writeOut("calibration", { calibration, model, perTrade: perTradeRows });
  out.push("", `Full per-trade detail: ${file}`);
  console.log(out.join("\n"));
}

function entryFrom(flag: string | boolean | undefined): EntryStrategy {
  const s = typeof flag === "string" ? flag : "at-decision";
  if (s === "actual") return atActualEntry();
  const m = /^at-decision(?:\+(\d+)m?)?$/.exec(s);
  if (m) return atDecision(Number(m[1] ?? 0));
  throw new Error(`unknown --entry ${s}`);
}

export function universeFilter(flags: CliArgs["flags"]): (c: UniverseCandidate) => boolean {
  const chain = typeof flags.chain === "string" ? flags.chain : undefined;
  const statuses = typeof flags.status === "string" ? new Set(flags.status.split(",")) : undefined;
  const from = typeof flags.from === "string" ? Date.parse(flags.from) / 1000 : -Infinity;
  const to = typeof flags.to === "string" ? Date.parse(flags.to) / 1000 : Infinity;
  const includeManual = Boolean(flags["include-manual"]);
  return (c) =>
    (!chain || c.chain === chain) &&
    (!statuses || statuses.has(c.status)) &&
    c.createdAt >= from &&
    c.createdAt < to &&
    (includeManual || c.qualificationPath !== "MANUAL_BUY_AND_HOLD");
}

async function runCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const exit = await loadExitRules(snapshot, flags);
  const entry = entryFrom(flags.entry);
  const pick = flags.costs === "p75" ? "p75" : "median";
  const { model, calibrated } = await loadCosts(pick);
  const equity = Number(flags.equity ?? 25);
  const sizePct = Number(flags["size-pct"] ?? 5);
  const refSize = Number(flags["ref-size"] ?? (equity * sizePct) / 100);
  const holdHours = Number(flags["hold-hours"] ?? 48);
  const maxConcurrent = flags["max-concurrent"] !== undefined ? Number(flags["max-concurrent"]) : undefined;
  const intrabar: IntrabarMode = flags.intrabar === "close" ? "close" : "worst";
  const candidates = snapshot.candidates.filter(universeFilter(flags));
  const rows = await runStrategy(candidates, seriesLoader(geckoClient(true)), {
    name: `${entry.name} / ${exit.name}`,
    entry,
    exitRules: () => exit.rules,
    legacyProfitSteps: flags["legacy-steps"] ? () => true : undefined,
    costs: model,
    refSizeUsd: refSize,
    holdWindowS: holdHours * 3_600,
    intrabar,
  });
  const reports = chainReports(rows, { startEquityUsd: equity, sizePct, maxConcurrent }, model);
  const out: string[] = [];
  out.push(formatChainReports(`${entry.name} entry, ${exit.name} exits, ${holdHours}h window, ${intrabar} intrabar`, reports, refSize), "");
  out.push(`Costs (${calibrated ? `calibrated, ${pick}` : "UNCALIBRATED defaults: run calibrate first"}):`, "", costsTable(model), "");
  out.push(`Wallet replay: each chain its own ${usd(equity)} wallet, ${sizePct}% of equity per entry${maxConcurrent ? `, max ${maxConcurrent} open` : ""}.`, "");
  for (const r of reports) {
    out.push(`${r.chain} equity curve:`, "", table(["time (UTC)", "equity"], curveSample(r.portfolio).map((p) => [p.date, usd(p.equityUsd)])), "");
  }
  const name = typeof flags.out === "string" ? flags.out : `run-${entry.name}-${exit.name}`.replace(/[^A-Za-z0-9_.+-]/g, "_");
  const file = await writeOut(name, {
    config: { entry: entry.name, exit: exit.name, exitRules: exit.rules, costs: model, pick, equity, sizePct, refSize, holdHours, maxConcurrent, intrabar, flags },
    summary: reports.map((r) => ({ chain: r.chain, stats: r.stats, portfolio: { ...r.portfolio, curve: undefined }, exits: r.exits, skipped: r.skipped })),
    curves: Object.fromEntries(reports.map((r) => [r.chain, r.portfolio.curve])),
    trades: rows.map((r) => ({
      candidateId: r.candidate.candidateId,
      symbol: r.candidate.symbol,
      chain: r.chain,
      status: r.candidate.status,
      createdAt: r.candidate.createdAt,
      skip: r.skip,
      entryTs: r.sim?.entryTs,
      tier: r.sim?.tier,
      exitReason: r.sim?.exitReason,
      peakMultiple: r.sim?.peakMultiple,
      holdMinutes: r.sim?.holdMinutes,
      netPct: r.valued?.netPct,
      legs: r.sim?.legs.length,
      seriesNote: r.seriesNote,
    })),
  });
  out.push(`Per-trade detail: ${file}`);
  console.log(out.join("\n"));
}

export async function main(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "snapshot": {
      await getSnapshot(true);
      return;
    }
    case "fetch": {
      const snapshot = await getSnapshot(Boolean(flags["refresh-universe"]));
      await fetchAll(snapshot, flags);
      return;
    }
    case "calibrate": {
      await calibrateCmd(await getSnapshot(false), flags);
      return;
    }
    case "run": {
      await runCmd(await getSnapshot(false), flags);
      return;
    }
    default:
      console.log(`usage: tsx scripts/backtest-replay.ts <command> [flags]

  snapshot                     read the candidate universe + actual trades from prod (read-only) into the cache
  fetch [--pass fine|coarse] [--only-traded]
                               fill the GeckoTerminal candle cache (~10 req/min, one request per pool per
                               pass). fine: 1m around decision/entry (traded also get 5m); coarse: 5m to +72h
  calibrate [--costs median|p75]
                               measure real fill costs vs candles, save the cost model, and replay our
                               autonomous live trades (as-was rules, v1.8) against what actually happened
  run [--entry at-decision[+Nm]|actual] [--exit v1.8 | --exit-json file] [--chain c] [--status S1,S2]
      [--from iso] [--to iso] [--include-manual] [--equity 25] [--size-pct 5] [--ref-size usd]
      [--hold-hours 48] [--max-concurrent n] [--costs median|p75] [--intrabar worst|close] [--legacy-steps] [--out name]
                               replay the universe from cache only (never fetches, never writes the DB)`);
  }
}
