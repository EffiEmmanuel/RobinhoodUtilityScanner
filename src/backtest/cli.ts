import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExitRules } from "../trading/strategy";
import { type ChainCalibration, MIN_CHAIN_FILLS, calibrateChain, costModelFrom, exitCategory, type FillSample, fillSamples } from "./calibrate";
import { GeckoTerminalClient } from "./candles";
import { asPaperTrade, type FidelityPair, loadPaperBook, type PaperBook, summarizeFidelity } from "./fidelity";
import { type CostModel, DEFAULT_COSTS, chainCosts } from "./costs";
import { decideGrid, detectionMcap, type EntryFilter, FORENSICS_GATES, type ForensicsRow, launchVenue, passesEntryFilter, type PairSummary, pairRows, summarizeByPeak, summarizeByVenue, summarizePairs, summarizePumpVsOther } from "./compare";
import { flatRule, sizingSweep, userBrackets } from "./sizing";
import { atActualEntry, atDecision, atSignal, type EntryStrategy, parseSignalRows, survivor, SURVIVOR_DEFAULTS, type SurvivorParams } from "./entries";
import { type PriceSeries, loadPriceSeries } from "./marketData";
import { chainReports, curveSample, formatChainReports, num, pct, table, usd } from "./report";
import { type RunConfig, type RunRow, runStrategy } from "./run";
import type { IntrabarMode } from "./simulate";
import { bootstrapDiffCI, mean, mulberry32, simulatePortfolio, tradeStats } from "./stats";
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
  const chain = typeof flags.chain === "string" ? flags.chain : undefined;
  // --ids <json file>: only candidates listed there (any array of rows with a candidateId), e.g. C's forensics table.
  let ids: Set<string> | undefined;
  if (typeof flags.ids === "string") {
    // An array of rows, C's { rows }, or the cached paper book's { positions }.
    const raw = JSON.parse(await readFile(flags.ids, "utf8")) as { candidateId?: string }[] | { rows?: { candidateId?: string }[]; positions?: { candidateId?: string }[] };
    ids = new Set((Array.isArray(raw) ? raw : (raw.rows ?? raw.positions ?? [])).map((r) => String(r.candidateId)));
  }
  const list = ordered.filter((c) => (!flags["only-traded"] || c.trades.length > 0) && (!chain || c.chain === chain) && (!ids || ids.has(c.candidateId)));
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
  // --venue pump.fun | other | <dexId>: launch venue as compare.ts's launchVenue reads it.
  const venue = typeof flags.venue === "string" ? flags.venue : undefined;
  const venueOk = (c: UniverseCandidate) => !venue || (venue === "other" ? launchVenue(c) !== "pump.fun" : launchVenue(c) === venue);
  return (c) =>
    venueOk(c) &&
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

async function exitConfig(snapshot: UniverseSnapshot, spec: string): Promise<{ name: string; rules: ExitRules }> {
  if (spec.endsWith(".json")) return { name: path.basename(spec, ".json"), rules: JSON.parse(await readFile(spec, "utf8")) as ExitRules };
  return { name: spec, rules: findExitRules(snapshot, spec) };
}

function pairTable(summaries: PairSummary[], aName: string, bName: string): string {
  return table(
    ["group", "n", `${aName} mean`, `${bName} mean`, `${bName} - ${aName}`, "90% CI", `${bName} better/worse`, "gained", "gave back", `${aName} total`, `${bName} total`],
    summaries.map((x) => [
      x.group,
      x.n,
      pct(x.aMeanPct),
      pct(x.bMeanPct),
      pct(x.diffMeanPct),
      x.n ? `${pct(x.diffCI90[0])} .. ${pct(x.diffCI90[1])}` : "n/a",
      `${x.bBetter}/${x.bWorse}`,
      `${num(x.gainedPct, 0)} pts`,
      `${num(x.gaveBackPct, 0)} pts`,
      usd(x.aTotalUsd),
      usd(x.bTotalUsd),
    ])
  );
}

/**
 * B2: two exit configs over identical entries, paired per trade, in both
 * intrabar modes. Universe entries at decision time; the actual-trade subset
 * at our real entry time, fill and size.
 */
async function compareCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const a = await exitConfig(snapshot, typeof flags.exit === "string" ? flags.exit : "v1.8");
  const bSpec = typeof flags.vs === "string" ? flags.vs : undefined;
  if (!bSpec) throw new Error("compare needs --vs <version | file.json>");
  const b = await exitConfig(snapshot, bSpec);
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const equity = Number(flags.equity ?? 25);
  const sizePct = Number(flags["size-pct"] ?? 5);
  const refSize = Number(flags["ref-size"] ?? (equity * sizePct) / 100);
  const holdWindowS = Number(flags["hold-hours"] ?? 48) * 3_600;
  const getSeries = seriesLoader(geckoClient(true));
  const universe = snapshot.candidates.filter(universeFilter(flags));
  const actual = perTrade(snapshot, (c) => c.trades.length > 0 && c.qualificationPath !== "MANUAL_BUY_AND_HOLD").filter((c) => c.trades[0].mode === "LIVE");
  const out: string[] = [`## ${a.name} vs ${b.name}`, ""];
  out.push(`Per-trade returns are net of slippage, impact and gas, as % of the position. Universe positions are ${usd(refSize)}; actual trades use their real size. "gained"/"gave back" sum the per-trade differences in % points.`, "");
  const saved: Record<string, unknown> = {};
  for (const mode of ["worst", "close"] as const) {
    const base = { costs: model, refSizeUsd: refSize, holdWindowS, intrabar: mode };
    const uA = await runStrategy(universe, getSeries, { ...base, name: a.name, entry: entryFrom(flags.entry), exitRules: () => a.rules });
    const uB = await runStrategy(universe, getSeries, { ...base, name: b.name, entry: entryFrom(flags.entry), exitRules: () => b.rules });
    const real = { ...base, entry: atActualEntry(), useActualEntryFill: true, sizeFor: (c: UniverseCandidate) => c.trades[0].positionSizeUsd };
    const tA = await runStrategy(actual, getSeries, { ...real, name: a.name, exitRules: () => a.rules });
    const tB = await runStrategy(actual, getSeries, { ...real, name: b.name, exitRules: () => b.rules });
    for (const chain of [...new Set(universe.map((c) => c.chain))].sort()) {
      const pairs = pairRows(uA.filter((r) => r.chain === chain), uB.filter((r) => r.chain === chain));
      out.push(`### ${chain} universe, entry at decision, ${mode} intrabar`, "", pairTable([...summarizeByPeak(pairs), ...summarizeByVenue(pairs)], a.name, b.name), "");
      saved[`${chain}-universe-${mode}`] = pairs;
    }
    const tPairs = pairRows(tA, tB);
    out.push(
      `### Our ${actual.length} autonomous live trades (real entry, fill and size), ${mode} intrabar`,
      "",
      pairTable([...summarizeByPeak(tPairs), ...summarizeByVenue(tPairs)], a.name, b.name),
      ""
    );
    saved[`actual-${mode}`] = tPairs;
    const biggest = [...tPairs].sort((x, y) => Math.abs(y.bUsd - y.aUsd) - Math.abs(x.bUsd - x.aUsd)).slice(0, 8);
    out.push(
      table(
        ["symbol", "path peak", `${a.name}`, `${a.name} exit`, `${b.name}`, `${b.name} exit`],
        biggest.map((p) => [p.symbol ?? "?", p.pathPeak ? `${num(p.pathPeak)}x` : "?", usd(p.aUsd), p.aExit.slice(0, 40), usd(p.bUsd), p.bExit.slice(0, 40)])
      ),
      ""
    );
  }
  const file = await writeOut(typeof flags.out === "string" ? flags.out : `compare-${a.name}-vs-${b.name}`, { a, b, costs: model, refSize, pairs: saved });
  out.push(`Per-trade pairs: ${file}`);
  console.log(out.join("\n"));
}

/**
 * Compounding sizing sweep over the replayed per-trade outcomes of a chain's
 * universe, for each exit config and intrabar mode.
 */
async function sizingCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const specs = (typeof flags.exits === "string" ? flags.exits : "v1.8").split(",");
  const exits = await Promise.all(specs.map((spec) => exitConfig(snapshot, spec)));
  const chain = typeof flags.chain === "string" ? flags.chain : "solana";
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const costs = chainCosts(model, chain);
  const startUsd = Number(flags.start ?? 21);
  const paths = Number(flags.paths ?? 5000);
  const rules = [userBrackets(40), userBrackets(20), flatRule(10), flatRule(5)];
  const universe = snapshot.candidates.filter(universeFilter({ ...flags, chain }));
  const getSeries = seriesLoader(geckoClient(true));
  const out: string[] = [
    `## Compounding sizing sweep, ${chain}, from ${usd(startUsd)}`,
    "",
    `${paths} random 100-trade sequences drawn with replacement from the replayed ${chain} universe (entry at decision). Each draw is re-priced at its real size (gas per swap, impact). Trades are taken one at a time, so overlapping positions and losing streaks can make real drawdowns deeper.`,
    "",
  ];
  const rows: (string | number)[][] = [];
  for (const exit of exits) {
    for (const mode of ["worst", "close"] as const) {
      const run = await runStrategy(universe, getSeries, {
        name: exit.name,
        entry: entryFrom(flags.entry),
        exitRules: () => exit.rules,
        costs: model,
        refSizeUsd: startUsd * 0.1,
        holdWindowS: Number(flags["hold-hours"] ?? 48) * 3_600,
        intrabar: mode,
      });
      const trades = run.filter((r) => r.sim).map((r) => ({ sim: r.sim!, costs }));
      for (const rule of rules) {
        const res = sizingSweep(trades, rule, { startUsd, trades: 100, checkpoint: 50, paths, reachUsd: 100 });
        rows.push([
          exit.name,
          mode,
          trades.length,
          res.rule,
          usd(res.medianAtCheckpoint),
          usd(res.medianAtEnd),
          `${usd(res.p10AtEnd)} .. ${usd(res.p90AtEnd)}`,
          pct(res.pBelowHalf * 100, 0),
          pct(res.pRuin * 100, 0),
          pct(res.pReach * 100, 0),
        ]);
      }
    }
  }
  out.push(
    table(["exits", "intrabar", "trades in pool", "sizing", "median @50", "median @100", "p10 .. p90 @100", "P(<50% start)", "P(<10%, ruin)", "P(reach $100)"], rows)
  );
  console.log(out.join("\n"));
}

const GRID_RULE = [
  "Pre-registered decision rule (fixed before the full-universe run):",
  "- Primary: mean net return per trade, paired against V0, full Solana universe, worst-case wicks, median costs.",
  "- Secondary: the same with close-only wicks.",
  "- A variant qualifies if it is no worse than V0 in the primary (paired mean >= 0) and doesn't lose in the secondary (>= 0).",
  "- Among qualifiers the simplest wins. Order, fixed in advance by changes from v1.8: V1 (1), V4 (2), V2 (3), V3 (3).",
  "  Another qualifier replaces it only if it beats it head to head in BOTH modes with a 90% CI clear of 0.",
  "- Nothing qualifies: keep v1.8.",
  "None of these replays include the AI review, live's only profit-taker since 2026-09-22; they compare the deterministic exits only.",
  "V1 and V4 add no fixed profit-taking multiple (compatible with the 09-22 'AI decides profit-taking' directive); V2 and V3 reverse it.",
];

function gridRow(name: string, parts: PairSummary[]): (string | number)[] {
  const [all, ...buckets] = parts;
  const cell = (x: PairSummary) => (x.n ? `${pct(x.diffMeanPct)} [${pct(x.diffCI90[0])}, ${pct(x.diffCI90[1])}] ${x.bBetter}/${x.bWorse} n=${x.n}` : "n=0");
  return [name, `${pct(all.aMeanPct)} -> ${pct(all.bMeanPct)}`, cell(all), ...buckets.map(cell), `${usd(all.aTotalUsd)} -> ${usd(all.bTotalUsd)}`];
}

/** B2 grid: V0 plus pre-registered variants, paired, with the pre-registered verdict. */
async function gridCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const base = await exitConfig(snapshot, typeof flags.exit === "string" ? flags.exit : "v1.8");
  const specs = (typeof flags.variants === "string" ? flags.variants : "").split(",").filter(Boolean);
  if (!specs.length) throw new Error("grid needs --variants V1=file.json,V2=file.json,... (simplest first)");
  const variants = await Promise.all(
    specs.map(async (spec) => {
      const [name, file] = spec.split("=");
      return { name, rules: (await exitConfig(snapshot, file)).rules };
    })
  );
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const equity = Number(flags.equity ?? 25);
  const refSize = Number(flags["ref-size"] ?? (equity * Number(flags["size-pct"] ?? 5)) / 100);
  const holdWindowS = Number(flags["hold-hours"] ?? 48) * 3_600;
  const getSeries = seriesLoader(geckoClient(true));
  const universe = snapshot.candidates.filter(universeFilter(flags));
  const actual = perTrade(snapshot, (c) => c.trades.length > 0 && c.qualificationPath !== "MANUAL_BUY_AND_HOLD").filter((c) => c.trades[0].mode === "LIVE");
  const modes = ["worst", "close"] as const;
  const runs = new Map<string, RunRow[]>(); // `${variant}|${subset}|${mode}`
  for (const mode of modes) {
    const common = { costs: model, refSizeUsd: refSize, holdWindowS, intrabar: mode };
    const real = { ...common, entry: atActualEntry(), useActualEntryFill: true, sizeFor: (c: UniverseCandidate) => c.trades[0].positionSizeUsd };
    for (const v of [{ name: "V0", rules: base.rules }, ...variants]) {
      runs.set(`${v.name}|universe|${mode}`, await runStrategy(universe, getSeries, { ...common, name: v.name, entry: entryFrom(flags.entry), exitRules: () => v.rules }));
      runs.set(`${v.name}|actual|${mode}`, await runStrategy(actual, getSeries, { ...real, name: v.name, exitRules: () => v.rules }));
    }
  }
  const pairsOf = (a: string, b: string, subset: string, mode: string) => pairRows(runs.get(`${a}|${subset}|${mode}`)!, runs.get(`${b}|${subset}|${mode}`)!);
  const byPeak = (name: string, subset: string, mode: string) => summarizeByPeak(pairsOf("V0", name, subset, mode));

  const chains = [...new Set(universe.map((c) => c.chain))].join(", ");
  const n0 = runs.get("V0|universe|worst")!;
  const out: string[] = [`## B2 exit grid vs V0 (${base.name}), ${chains} universe`, "", ...GRID_RULE, ""];
  out.push(
    `Universe: ${universe.length} candidates, ${n0.filter((r) => r.valued).length} replayed (${n0.length - n0.filter((r) => r.valued).length} without candles), entry at decision, ${usd(refSize)} positions. Cells: paired mean difference vs V0 in % points per trade [90% CI] better/worse n.`,
    ""
  );
  const headers = ["variant", "V0 -> variant mean", "all", "peak <2x", "peak 2-4x", "peak >=4x", "total"];
  for (const [subset, label] of [
    ["universe", "universe"],
    ["actual", `our ${actual.length} autonomous live trades (real entry, fill, size; context only)`],
  ] as const) {
    for (const mode of modes) {
      out.push(`### ${label}, ${mode === "worst" ? "worst-case wicks" : "close-only"}${subset === "universe" ? (mode === "worst" ? " (PRIMARY)" : " (SECONDARY)") : ""}`, "");
      out.push(table(headers, variants.map((v) => gridRow(v.name, byPeak(v.name, subset, mode)))), "");
    }
  }
  out.push("### Launch venue split (universe)", "");
  out.push(
    table(
      ["variant", "wicks", "pump.fun launches", "other launches"],
      variants.flatMap((v) =>
        modes.map((mode) => {
          const [pump, other] = summarizePumpVsOther(pairsOf("V0", v.name, "universe", mode));
          const cell = (x: PairSummary) => (x.n ? `V0 ${pct(x.aMeanPct)}, delta ${pct(x.diffMeanPct)} [${pct(x.diffCI90[0])}, ${pct(x.diffCI90[1])}] n=${x.n}` : "n=0");
          return [v.name, mode, cell(pump), cell(other)];
        })
      )
    ),
    ""
  );

  const summaryAll = (a: string, b: string, mode: string) => summarizePairs("all", pairsOf(a, b, "universe", mode));
  const decision = decideGrid(
    variants.map((v) => ({ name: v.name, primary: summaryAll("V0", v.name, "worst"), secondary: summaryAll("V0", v.name, "close") })),
    (challenger, incumbent) => ({ primary: summaryAll(incumbent, challenger, "worst"), secondary: summaryAll(incumbent, challenger, "close") })
  );
  out.push("### Verdict under the pre-registered rule", "", ...decision.reasons.map((r) => `- ${r}`), "", `Winner: ${decision.winner}`, "");
  const file = await writeOut(typeof flags.out === "string" ? flags.out : "b2-grid", {
    base: base.name,
    variants,
    decision,
    pairs: Object.fromEntries(
      variants.flatMap((v) => (["universe", "actual"] as const).flatMap((subset) => modes.map((mode) => [`${v.name}|${subset}|${mode}`, pairsOf("V0", v.name, subset, mode)])))
    ),
  });
  out.push(`Per-trade pairs: ${file}`);
  console.log(out.join("\n"));
}

function statsRow(label: string, rows: RunRow[]): (string | number)[] {
  const done = rows.filter((r) => r.valued).map((r) => r.valued!);
  const st = tradeStats(done);
  return [
    label,
    rows.length,
    st.n,
    pct(st.winRate * 100, 0),
    pct(st.expectancyPct),
    st.n ? `${pct(st.expectancyCI90[0])} .. ${pct(st.expectancyCI90[1])}` : "n/a",
    pct(st.medianPct),
    num(st.profitFactor),
    usd(st.totalNetUsd),
  ];
}
const STATS_HEADERS = ["entry", "candidates", "trades", "win rate", "mean net/trade", "90% CI", "median", "profit factor", "total"];

/**
 * B3: survivor entries (T+6/12/24h) vs the early-entry baseline. Parameters
 * are chosen once, on the earlier half of dates, in the primary
 * (worst-case wick) mode, then scored on the later half in both modes.
 */
async function survivorCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const chain = typeof flags.chain === "string" ? flags.chain : "solana";
  const exit = await exitConfig(snapshot, typeof flags.exit === "string" ? flags.exit : "v1.8");
  const minTrain = Number(flags["min-train-trades"] ?? 15);
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const refSize = Number(flags["ref-size"] ?? 1.25);
  const holdWindowS = Number(flags["hold-hours"] ?? 48) * 3_600;
  const getSeries = seriesLoader(geckoClient(true));
  const universe = snapshot.candidates.filter(universeFilter({ ...flags, chain })).sort((a, b) => a.createdAt - b.createdAt);
  const split = universe[Math.floor(universe.length / 2)].createdAt;
  const train = universe.filter((c) => c.createdAt < split);
  const test = universe.filter((c) => c.createdAt >= split);
  const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  const grid: SurvivorParams[] = [];
  for (const checkHours of [6, 12, 24]) for (const minFractionOfPeak of [0.3, 0.5, 0.7]) for (const minVolumeUsd of [1_000, 5_000, 20_000]) grid.push({ ...SURVIVOR_DEFAULTS, checkHours, minFractionOfPeak, minVolumeUsd });
  const run = (cands: UniverseCandidate[], entry: EntryStrategy, mode: IntrabarMode) =>
    runStrategy(cands, getSeries, { name: entry.name, entry, exitRules: () => exit.rules, costs: model, refSizeUsd: refSize, holdWindowS, intrabar: mode });

  const out: string[] = [`## B3 survivor entries vs early entry, ${chain}, ${exit.name} exits`, ""];
  out.push(
    "Pre-registered: 27 parameter sets (check at T+6/12/24h x peak share X 0.3/0.5/0.7 x 2h volume $1k/$5k/$20k; fixed: pool traded in the last 60 min, price >= 20% of the decision price, breakout = a close above the best close of the 3h before the check, within 6h).",
    `The set with the best mean net return per trade on the TRAIN half (worst-case wicks, at least ${minTrain} trades) is the one scored on the TEST half. Nothing is re-tuned on TEST.`,
    `Train: ${train.length} candidates, ${iso(train[0].createdAt)} to ${iso(split)}. Test: ${test.length} candidates, ${iso(split)} to ${iso(test[test.length - 1].createdAt)}. ${usd(refSize)} positions, median costs.`,
    ""
  );
  const trainResults: { p: SurvivorParams; name: string; rows: RunRow[]; mean: number; n: number }[] = [];
  for (const p of grid) {
    const entry = survivor(p);
    const rows = await run(train, entry, "worst");
    const st = tradeStats(rows.filter((r) => r.valued).map((r) => r.valued!));
    trainResults.push({ p, name: entry.name, rows, mean: st.expectancyPct, n: st.n });
  }
  const eligible = trainResults.filter((r) => r.n >= minTrain).sort((a, b) => b.mean - a.mean);
  out.push("### TRAIN, worst-case wicks: top parameter sets", "");
  out.push(table(STATS_HEADERS, eligible.slice(0, 8).map((r) => statsRow(r.name, r.rows))), "");
  out.push(`${trainResults.length - eligible.length} of ${trainResults.length} sets had fewer than ${minTrain} train trades and were ineligible.`, "");
  if (!eligible.length) {
    console.log([...out, "No parameter set had enough train trades; nothing to test."].join("\n"));
    return;
  }
  const chosen = eligible[0];
  out.push(`Chosen on TRAIN: ${chosen.name}`, "");

  const saved: Record<string, unknown> = { chosen: chosen.p, split };
  for (const mode of ["worst", "close"] as const) {
    const base = atDecision();
    const [bTrain, bTest, sTrain, sTest] = [
      await run(train, base, mode),
      await run(test, base, mode),
      mode === "worst" ? chosen.rows : await run(train, survivor(chosen.p), mode),
      await run(test, survivor(chosen.p), mode),
    ];
    out.push(`### ${mode === "worst" ? "Worst-case wicks (primary)" : "Close-only"}`, "");
    out.push(
      table(STATS_HEADERS, [
        statsRow("early entry (at decision), TRAIN", bTrain),
        statsRow("survivor, TRAIN (in-sample)", sTrain),
        statsRow("early entry (at decision), TEST", bTest),
        statsRow("survivor, TEST (out-of-sample)", sTest),
      ]),
      ""
    );
    const venueRows = (["pump.fun", "other"] as const).flatMap((v) => {
      const pick = (rows: RunRow[]) => rows.filter((r) => (launchVenue(r.candidate) === "pump.fun") === (v === "pump.fun"));
      return [statsRow(`early entry, TEST, ${v} launches`, pick(bTest)), statsRow(`survivor, TEST, ${v} launches`, pick(sTest))];
    });
    out.push(table(STATS_HEADERS, venueRows), "");
    const skips: Record<string, number> = {};
    for (const r of sTest) if (r.skip) skips[r.skip] = (skips[r.skip] ?? 0) + 1;
    out.push(`Survivor TEST candidates not entered: ${Object.entries(skips).map(([k, v]) => `${k} ${v}`).join(", ")}`, "");

    // The early winners this would give up, whole universe.
    const bAll = [...bTrain, ...bTest];
    const sAll = new Map([...sTrain, ...sTest].map((r) => [r.candidate.candidateId, r]));
    const winners = bAll.filter((r) => r.valued && r.valued.netPct >= 50).sort((a, b) => b.valued!.netPct - a.valued!.netPct);
    out.push(`Early-entry winners (net >= +50%) and what the survivor rule did with them, ${mode}:`, "");
    out.push(
      table(
        ["symbol", "detected", "venue", "early entry net", "path peak", "survivor"],
        winners.map((r) => {
          const s = sAll.get(r.candidate.candidateId);
          return [
            r.candidate.symbol ?? "?",
            iso(r.candidate.createdAt),
            launchVenue(r.candidate),
            pct(r.valued!.netPct),
            r.pathPeak ? `${num(r.pathPeak)}x` : "?",
            s?.valued ? `entered, ${pct(s.valued.netPct)}` : `missed: ${s?.skip ?? "?"}`,
          ];
        })
      ),
      ""
    );
    saved[mode] = {
      baselineTest: bTest.map((r) => ({ id: r.candidate.candidateId, netPct: r.valued?.netPct, skip: r.skip })),
      survivorTest: sTest.map((r) => ({ id: r.candidate.candidateId, netPct: r.valued?.netPct, skip: r.skip, entryTs: r.sim?.entryTs })),
    };
  }
  const file = await writeOut(typeof flags.out === "string" ? flags.out : `b3-survivor-${chain}`, saved);
  out.push(`Detail: ${file}`);
  console.log(out.join("\n"));
}

/** B2 add-on: C's entry filters E1/E2 vs no filter, for each exit config, both wick modes. */
async function filtersCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const chain = typeof flags.chain === "string" ? flags.chain : "solana";
  const specs = (typeof flags.exits === "string" ? flags.exits : "v1.8").split(",");
  const exits = await Promise.all(
    specs.map(async (spec) => {
      const [label, file] = spec.includes("=") ? spec.split("=") : [spec, spec];
      return { label, rules: (await exitConfig(snapshot, file)).rules };
    })
  );
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const startUsd = Number(flags.start ?? 21);
  const refSize = Number(flags["ref-size"] ?? 1.25);
  const holdWindowS = Number(flags["hold-hours"] ?? 48) * 3_600;
  const universe = snapshot.candidates.filter(universeFilter({ ...flags, chain }));
  const getSeries = seriesLoader(geckoClient(true));
  const brackets = userBrackets(40);
  const filters: EntryFilter[] = ["none", "E1", "E2"];
  const out: string[] = [
    `## B2 entry filters, ${chain} universe (entry at decision)`,
    "",
    "E1: skip pump.fun launches detected at >= $50K market cap. E2: non-pump.fun launches only. Pre-registered with the grid's rule: judged on mean net return per trade, worst-case wicks primary, close-only must not lose.",
    `Per-trade figures at ${usd(refSize)}. Wallet: one ${usd(startUsd)} ${chain} wallet in time order, sized by the user's brackets (40% under $50 ...), cash-limited.`,
    "",
  ];
  const rows: (string | number)[][] = [];
  const cuts: string[] = [];
  for (const exit of exits) {
    for (const mode of ["worst", "close"] as const) {
      const run = await runStrategy(universe, getSeries, { name: exit.label, entry: atDecision(), exitRules: () => exit.rules, costs: model, refSizeUsd: refSize, holdWindowS, intrabar: mode });
      const done = run.filter((r) => r.valued);
      const base = done.filter((r) => passesEntryFilter(r.candidate, "none"));
      for (const f of filters) {
        const kept = done.filter((r) => passesEntryFilter(r.candidate, f));
        const st = tradeStats(kept.map((r) => r.valued!));
        const wallet = simulatePortfolio(
          kept.map((r) => ({ chain, sim: r.sim! })),
          { startEquityUsd: startUsd, sizePct: 0, sizing: brackets.fraction, costs: model }
        );
        const cut = base.filter((r) => !passesEntryFilter(r.candidate, f));
        const cutStats = tradeStats(cut.map((r) => r.valued!));
        rows.push([
          exit.label,
          mode,
          f,
          st.n,
          pct(st.winRate * 100, 0),
          pct(st.expectancyPct),
          st.n ? `${pct(st.expectancyCI90[0])} .. ${pct(st.expectancyCI90[1])}` : "n/a",
          f === "none"
            ? "-"
            : `${cut.length} cut (mean ${pct(cutStats.expectancyPct)}); kept - cut ${pct(st.expectancyPct - cutStats.expectancyPct)} [${bootstrapDiffCI(
                kept.map((r) => r.valued!.netPct),
                cut.map((r) => r.valued!.netPct)
              )
                .map((x) => pct(x))
                .join(", ")}]`,
          `${usd(wallet.finalEquityUsd)} (${pct(wallet.returnPct, 0)}), max DD ${pct(-wallet.maxDrawdownPct, 0)}, ${wallet.taken} taken`,
        ]);
        if (f !== "none" && mode === "worst") {
          const top = cut.sort((a, b) => b.valued!.netPct - a.valued!.netPct).slice(0, 8);
          cuts.push(
            `${exit.label} / ${f} cuts these winners (worst-case wicks): ${top.filter((r) => r.valued!.netPct > 0).map((r) => `${r.candidate.symbol ?? "?"} ${pct(r.valued!.netPct, 0)} (peak ${r.pathPeak ? num(r.pathPeak) : "?"}x, mcap $${Math.round((detectionMcap(r.candidate) ?? 0) / 1000)}K)`).join(", ") || "none"}`
          );
        }
      }
    }
  }
  out.push(table(["exits", "wicks", "filter", "trades", "win rate", "mean net/trade", "90% CI", "trades removed", "bracket wallet from start"], rows), "");
  out.push(...cuts.map((c) => `- ${c}`));
  console.log(out.join("\n"));
}

/**
 * C's forensics gates judged by replay P&L, like E1/E2: kept minus removed
 * with a 90% CI, both wick modes, and the biggest winners each gate cuts.
 * Only candidates C has a forensics row for take part.
 */
async function forensicsCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const file = typeof flags.table === "string" ? flags.table : undefined;
  if (!file) throw new Error("forensics needs --table <C's launch_forensics_by_candidate.json>");
  const raw = JSON.parse(await readFile(file, "utf8")) as ForensicsRow[] | { rows: ForensicsRow[] };
  const rows = Array.isArray(raw) ? raw : raw.rows;
  const byId = new Map(rows.filter((r) => r.ok !== false).map((r) => [String(r.candidateId), r]));
  const exit = await exitConfig(snapshot, typeof flags.exit === "string" ? flags.exit : "v1.8");
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const refSize = Number(flags["ref-size"] ?? 1.25);
  const holdWindowS = Number(flags["hold-hours"] ?? 48) * 3_600;
  const getSeries = seriesLoader(geckoClient(true));
  const out: string[] = [
    `## Launch-forensics gates judged by replay P&L (${exit.name} exits, entry at decision, ${usd(refSize)} positions)`,
    "",
    `C's table: ${rows.length} rows, ${byId.size} usable. A gate removes a candidate only when its feature is known and crosses the threshold; unknown passes.`,
    "Passes = kept minus removed >= 0 in BOTH wick modes; clears = the worst-case-wick CI is above 0.",
    "",
  ];
  const tableRows: (string | number)[][] = [];
  const cuts: string[] = [];
  const halves: string[] = [];
  for (const chain of [...new Set(FORENSICS_GATES.map((g) => g.chain))]) {
    const universe = snapshot.candidates.filter(universeFilter({ ...flags, chain })).filter((c) => byId.has(c.candidateId));
    const runs: Record<string, RunRow[]> = {};
    for (const mode of ["worst", "close"] as const) {
      runs[mode] = (await runStrategy(universe, getSeries, { name: exit.name, entry: atDecision(), exitRules: () => exit.rules, costs: model, refSizeUsd: refSize, holdWindowS, intrabar: mode })).filter((r) => r.valued);
    }
    // The same median-date split B3 uses: a gate should hold in both halves.
    const sortedTimes = universe.map((c) => c.createdAt).sort((a, b) => a - b);
    const split = sortedTimes[Math.floor(sortedTimes.length / 2)] ?? 0;
    for (const gate of FORENSICS_GATES.filter((g) => g.chain === chain)) {
      const verdict: string[] = [];
      for (const mode of ["worst", "close"] as const) {
        const done = runs[mode];
        for (const [label, half] of [
          ["early half", done.filter((r) => r.candidate.createdAt < split)],
          ["late half", done.filter((r) => r.candidate.createdAt >= split)],
        ] as const) {
          const hk = half.filter((r) => !gate.removes(byId.get(r.candidate.candidateId)!)).map((r) => r.valued!.netPct);
          const hr = half.filter((r) => gate.removes(byId.get(r.candidate.candidateId)!)).map((r) => r.valued!.netPct);
          const hd = mean(hk) - mean(hr);
          const hci = bootstrapDiffCI(hk, hr);
          halves.push(`${gate.name} ${mode} ${label}: ${hk.length} kept / ${hr.length} removed, kept - removed ${hr.length && hk.length ? `${pct(hd)} [${pct(hci[0])}, ${pct(hci[1])}]` : "n/a"}`);
        }
        const removed = done.filter((r) => gate.removes(byId.get(r.candidate.candidateId)!));
        const kept = done.filter((r) => !gate.removes(byId.get(r.candidate.candidateId)!));
        const k = tradeStats(kept.map((r) => r.valued!));
        const rm = tradeStats(removed.map((r) => r.valued!));
        const diff = k.expectancyPct - rm.expectancyPct;
        const ci = bootstrapDiffCI(kept.map((r) => r.valued!.netPct), removed.map((r) => r.valued!.netPct));
        verdict.push(`${mode} ${Number.isFinite(diff) && diff >= 0 ? "ok" : "fails"}${mode === "worst" && ci[0] > 0 ? " (clears)" : ""}`);
        tableRows.push([
          `${gate.name}: ${gate.describe}`,
          mode,
          `${done.length}`,
          `${kept.length} kept, mean ${pct(k.expectancyPct)}`,
          `${removed.length} removed, mean ${pct(rm.expectancyPct)}`,
          removed.length && kept.length ? `${pct(diff)} [${pct(ci[0])}, ${pct(ci[1])}]` : "n/a",
        ]);
        if (mode === "worst") {
          const top = removed.filter((r) => r.valued!.netPct > 0).sort((a, b) => b.valued!.netPct - a.valued!.netPct).slice(0, 8);
          cuts.push(`${gate.name} cuts: ${top.map((r) => `${r.candidate.symbol ?? "?"} ${pct(r.valued!.netPct, 0)} (peak ${r.pathPeak ? num(r.pathPeak) : "?"}x)`).join(", ") || "no winners"}`);
        }
      }
      const passes = verdict.every((v) => v.includes("ok"));
      cuts.push(`${gate.name} verdict: ${verdict.join(", ")} -> ${passes ? "PASSES" : "does not pass"}`);
    }
  }
  out.push(table(["gate", "wicks", "replayed", "kept", "removed", "kept - removed [90% CI]"], tableRows), "", ...cuts.map((c) => `- ${c}`));
  out.push("", "By date half (median decision time per chain):", "", ...halves.map((h) => `- ${h}`));
  console.log(out.join("\n"));
}

const STOPS_RULE = [
  "Pre-registered (coordinator, 2026-09-26), all v1.8 exits otherwise, full Solana universe, entry at decision:",
  "- S0: v1.8 as is. Every stop sells on the first mark past its line, intrabar wick or not.",
  "- S1: exitRules.stopConfirm { seconds, appliesTo: maxLoss }: the 15% stop sells only once the mark has stayed past it for `seconds`; the 25% catastrophic stop stays immediate.",
  "- S3: stopConfirm { seconds, appliesTo: both }: no immediate price stop at all.",
  "- S2: S1 with catastrophicLossPercent 40.",
  "- Runs through the live evaluateExits and nextStopBreach (positionManager.ts), with the replay's tick times as mark times:",
  "  worst-case wicks tick every 20s along the bar (O,L,H,C or O,H,L,C), close-only every 60s at the closes.",
  "- Same rule as B2: paired vs S0; primary worst-case wicks, median costs; qualifies if >= 0 there and doesn't lose close-only.",
  "  Simplest first: S1, then S3, then S2. A later one replaces the incumbent only if ahead in both modes with a CI clear of 0.",
];

/** B5: wick-proof stops, paired against S0 (v1.8 as is). */
async function stopsCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const base = findExitRules(snapshot, "v1.8");
  const seconds = Number(flags.seconds ?? 30);
  const variants: { name: string; describe: string; rules: ExitRules }[] = [
    { name: "S0", describe: "v1.8 as is", rules: base },
    { name: "S1", describe: `max-loss confirmed ${seconds}s`, rules: { ...base, stopConfirm: { seconds, appliesTo: "maxLoss" } } },
    { name: "S3", describe: `both stops confirmed ${seconds}s`, rules: { ...base, stopConfirm: { seconds, appliesTo: "both" } } },
    { name: "S2", describe: `max-loss confirmed ${seconds}s, catastrophic 40%`, rules: { ...base, catastrophicLossPercent: 40, stopConfirm: { seconds, appliesTo: "maxLoss" } } },
  ];
  const chain = typeof flags.chain === "string" ? flags.chain : "solana";
  const refSize = Number(flags["ref-size"] ?? 1.25);
  const getSeries = seriesLoader(geckoClient(true));
  const universe = snapshot.candidates.filter(universeFilter({ ...flags, chain }));
  const actual = perTrade(snapshot, (c) => c.trades.length > 0 && c.qualificationPath !== "MANUAL_BUY_AND_HOLD" && c.chain === chain).filter((c) => c.trades[0].mode === "LIVE");
  const cells: { key: string; mode: IntrabarMode; pick: "median" | "p75"; subset: "universe" | "actual" }[] = [
    { key: "primary", mode: "worst", pick: "median", subset: "universe" },
    { key: "secondary", mode: "close", pick: "median", subset: "universe" },
    { key: "p75 costs", mode: "worst", pick: "p75", subset: "universe" },
    { key: `our ${actual.length} live ${chain} trades`, mode: "worst", pick: "median", subset: "actual" },
  ];
  const runs = new Map<string, RunRow[]>();
  for (const cell of cells) {
    const { model } = await loadCosts(cell.pick);
    for (const v of variants) {
      const cfg = { name: v.name, exitRules: () => v.rules, costs: model, refSizeUsd: refSize, intrabar: cell.mode };
      runs.set(
        `${cell.key}|${v.name}`,
        cell.subset === "universe"
          ? await runStrategy(universe, getSeries, { ...cfg, entry: atDecision() })
          : await runStrategy(actual, getSeries, { ...cfg, entry: atActualEntry(), useActualEntryFill: true, sizeFor: (c) => c.trades[0].positionSizeUsd })
      );
    }
  }
  const pairsOf = (cell: string, a: string, b: string) => pairRows(runs.get(`${cell}|${a}`)!, runs.get(`${cell}|${b}`)!);
  const out: string[] = [`## B5 stop confirmation (${seconds}s), ${chain}`, "", ...STOPS_RULE, ""];
  const headers = ["variant", "S0 -> variant mean", "all", "peak <2x", "peak 2-4x", "peak >=4x", "total"];
  for (const cell of cells) {
    out.push(`### ${cell.key}: ${cell.mode === "worst" ? "worst-case wicks" : "close-only"}, ${cell.pick} costs`, "");
    out.push(table(headers, variants.slice(1).map((v) => gridRow(v.name, summarizeByPeak(pairsOf(cell.key, "S0", v.name))))), "");
  }
  out.push("### Launch venue split (primary)", "");
  out.push(
    table(
      ["variant", "pump.fun launches", "other launches"],
      variants.slice(1).map((v) => {
        const [pump, other] = summarizePumpVsOther(pairsOf("primary", "S0", v.name));
        const cell = (x: PairSummary) => (x.n ? `S0 ${pct(x.aMeanPct)}, delta ${pct(x.diffMeanPct)} [${pct(x.diffCI90[0])}, ${pct(x.diffCI90[1])}] ${x.bBetter}/${x.bWorse} n=${x.n}` : "n=0");
        return [v.name, cell(pump), cell(other)];
      })
    ),
    ""
  );
  for (const v of variants.slice(1)) {
    const pairs = pairsOf("primary", "S0", v.name);
    const line = (p: (typeof pairs)[number]) => `${p.symbol ?? "?"} ${pct(p.aPct, 0)} -> ${pct(p.bPct, 0)} (${p.bExit.slice(0, 48)})`;
    const worse = pairs.filter((p) => p.bPct < p.aPct - 1e-6).sort((a, b) => a.bPct - a.aPct - (b.bPct - b.aPct));
    const better = pairs.filter((p) => p.bPct > p.aPct + 1e-6).sort((a, b) => b.bPct - b.aPct - (a.bPct - a.aPct));
    out.push(`${v.name} made ${worse.length} trades worse (held into the crash), worst first: ${worse.slice(0, 8).map(line).join("; ")}`, "");
    out.push(`${v.name} made ${better.length} trades better (wick survived), best first: ${better.slice(0, 8).map(line).join("; ")}`, "");
  }
  const summaryAll = (cell: string, a: string, b: string) => summarizePairs("all", pairsOf(cell, a, b));
  const decision = decideGrid(
    variants.slice(1).map((v) => ({ name: v.name, primary: summaryAll("primary", "S0", v.name), secondary: summaryAll("secondary", "S0", v.name) })),
    (challenger, incumbent) => ({ primary: summaryAll("primary", incumbent, challenger), secondary: summaryAll("secondary", incumbent, challenger) })
  );
  out.push("### Verdict under the pre-registered rule", "", ...decision.reasons.map((r) => `- ${r}`), "", `Winner: ${decision.winner === "V0" ? "S0 (keep v1.8 stops)" : decision.winner}`);
  const file = await writeOut(typeof flags.out === "string" ? flags.out : "b5-stops", {
    decision,
    pairs: Object.fromEntries(cells.flatMap((c) => variants.slice(1).map((v) => [`${c.key}|${v.name}`, pairsOf(c.key, "S0", v.name)]))),
  });
  out.push("", `Per-trade pairs: ${file}`);
  console.log(out.join("\n"));
}

export const PAPER_FILE = path.join(CACHE_DIR, "paper.json");

/**
 * Paper-vs-replay fidelity: each paper strategy's closed positions replayed
 * through the backtester at the paper entry time, fill and size, compared
 * trade by trade. Needs a fresh universe snapshot and candles for the
 * candidates the paper book traded (snapshot, then fetch --chain solana).
 */
async function paperFidelityCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const min = Number(flags.min ?? 30);
  let book: PaperBook;
  if (flags.cached) {
    book = JSON.parse(await readFile(PAPER_FILE, "utf8")) as PaperBook;
  } else {
    console.error("reading the paper book from the production DB (read-only)...");
    book = await withReadOnlyProdQuery(loadPaperBook);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(PAPER_FILE, JSON.stringify(book));
  }
  if (!book.tablesExist) {
    console.log("The paper tables don't exist in this database yet (deployed with B4 on the next release). Nothing to compare.");
    return;
  }
  const byCandidate = new Map(snapshot.candidates.map((c) => [c.candidateId, c]));
  const versions = new Map(snapshot.strategyVersions.map((v) => [v.id, v]));
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const getSeries = seriesLoader(geckoClient(true));
  const out: string[] = ["## Paper vs replay fidelity", ""];
  const strategies = [...new Set(book.positions.map((p) => p.strategyName))].sort();
  for (const name of strategies) {
    const closed = book.positions.filter((p) => p.strategyName === name && p.status === "CLOSED" && p.realizedPnlUsd !== null);
    const missing = closed.filter((p) => !byCandidate.has(p.candidateId)).length;
    if (closed.length < min) {
      out.push(`${name}: ${closed.length} closed positions, fewer than ${min}. Skipped.`, "");
      continue;
    }
    const version = versions.get(closed[0].strategyVersionId);
    if (!version) {
      out.push(`${name}: its StrategyVersion ${closed[0].strategyVersionId} isn't in the snapshot; run snapshot again.`, "");
      continue;
    }
    const pseudo = closed.filter((p) => byCandidate.has(p.candidateId)).map((p) => asPaperTrade(byCandidate.get(p.candidateId)!, p));
    const byId = new Map(closed.map((p) => [p.id, p]));
    const rows: (string | number)[][] = [];
    for (const mode of ["worst", "close"] as const) {
      const run = await runStrategy(pseudo, getSeries, {
        name,
        entry: atActualEntry(),
        exitRules: () => version.exitRules,
        costs: model,
        refSizeUsd: 1,
        sizeFor: (c) => c.trades[0].positionSizeUsd,
        useActualEntryFill: true,
        intrabar: mode,
      });
      const pairs: FidelityPair[] = run
        .filter((r) => r.valued)
        .map((r) => {
          const p = byId.get(r.candidate.trades[0].id)!;
          return {
            positionId: p.id,
            symbol: r.candidate.symbol,
            paperUsd: p.realizedPnlUsd!,
            simUsd: r.valued!.netUsd,
            paperPct: (p.realizedPnlUsd! / p.costBasisUsd) * 100,
            // Same base as the paper book's: size plus buy gas.
            simPct: (r.valued!.netUsd / (r.valued!.sizeUsd + chainCosts(model, r.chain).gasBuyUsd)) * 100,
            paperExit: p.exitReason ?? "",
            simExit: r.sim!.exitReason,
          };
        });
      const f = summarizeFidelity(pairs);
      rows.push([
        mode,
        `${f.n} of ${closed.length}${missing ? ` (${missing} not in snapshot)` : ""}`,
        `${usd(f.paperTotalUsd)} / ${pct(f.paperMeanPct)}`,
        `${usd(f.simTotalUsd)} / ${pct(f.simMeanPct)}`,
        `${num(f.meanAbsErrorPts, 1)} (median ${num(f.medianAbsErrorPts, 1)})`,
        num(f.correlation),
        `${f.sameExitType}/${f.n}`,
        f.paperWriteOffs,
      ]);
      if (mode === "worst") {
        const gaps = [...pairs].sort((a, b) => Math.abs(b.simPct - b.paperPct) - Math.abs(a.simPct - a.paperPct)).slice(0, 8);
        out.push(`### ${name} (${version.version})`, "", "Largest gaps, worst-case wicks:", "");
        out.push(table(["symbol", "paper", "paper exit", "replay", "replay exit"], gaps.map((g) => [g.symbol ?? "?", pct(g.paperPct), g.paperExit.slice(0, 40), pct(g.simPct), g.simExit.slice(0, 40)])), "");
      }
    }
    out.push(table(["wicks", "positions", "paper total / mean", "replay total / mean", "mean abs error, pts", "correlation", "same exit type", "paper write-offs"], rows), "");
  }
  console.log(out.join("\n"));
}

/**
 * C2 smart-wallet signals: (1) does a signal pick better candidates? At
 * decision-time entry, signal-present vs absent (kept minus removed, as a
 * filter would). (2) does waiting for the signal help? The same candidates
 * entered at the signal vs at decision, paired. Both wick modes, date halves.
 */
async function signalsCmd(snapshot: UniverseSnapshot, flags: CliArgs["flags"]): Promise<void> {
  const file = typeof flags.table === "string" ? flags.table : undefined;
  if (!file) throw new Error("signals needs --table <C2 signal table .json>");
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const signals = parseSignalRows(Array.isArray(raw) ? raw : raw.rows, typeof flags.field === "string" ? flags.field : undefined);
  const chain = typeof flags.chain === "string" ? flags.chain : "solana";
  const exit = await exitConfig(snapshot, typeof flags.exit === "string" ? flags.exit : "v1.8");
  const { model } = await loadCosts(flags.costs === "p75" ? "p75" : "median");
  const refSize = Number(flags["ref-size"] ?? 1.25);
  const getSeries = seriesLoader(geckoClient(true));
  const universe = snapshot.candidates.filter(universeFilter({ ...flags, chain }));
  const sorted = universe.map((c) => c.createdAt).sort((a, b) => a - b);
  const split = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const withSignal = universe.filter((c) => signals.has(c.candidateId));
  const out: string[] = [
    `## C2 signals, ${chain} (${exit.name} exits, ${usd(refSize)} positions)`,
    "",
    `${signals.size} signals in the table; ${withSignal.length} of ${universe.length} ${chain} candidates have one (${withSignal.filter((c) => signals.get(c.candidateId)! < c.createdAt).length} fired before the decision and enter at it).`,
    "",
  ];
  const rows: (string | number)[][] = [];
  for (const mode of ["worst", "close"] as const) {
    const cfg = { name: exit.name, exitRules: () => exit.rules, costs: model, refSizeUsd: refSize, intrabar: mode };
    const atDec = (await runStrategy(universe, getSeries, { ...cfg, entry: atDecision() })).filter((r) => r.valued);
    const atSig = (await runStrategy(withSignal, getSeries, { ...cfg, entry: atSignal(signals) })).filter((r) => r.valued);
    for (const [label, keep] of [
      ["all", () => true],
      ["early half", (c: UniverseCandidate) => c.createdAt < split],
      ["late half", (c: UniverseCandidate) => c.createdAt >= split],
    ] as const) {
      const dec = atDec.filter((r) => keep(r.candidate));
      const yes = dec.filter((r) => signals.has(r.candidate.candidateId)).map((r) => r.valued!.netPct);
      const no = dec.filter((r) => !signals.has(r.candidate.candidateId)).map((r) => r.valued!.netPct);
      const ci = bootstrapDiffCI(yes, no);
      const paired = summarizePairs(label, pairRows(dec.filter((r) => signals.has(r.candidate.candidateId)), atSig.filter((r) => keep(r.candidate))));
      rows.push([
        mode,
        label,
        `${yes.length} with / ${no.length} without`,
        yes.length && no.length ? `${pct(mean(yes) - mean(no))} [${pct(ci[0])}, ${pct(ci[1])}]` : "n/a",
        `${pct(mean(yes))}`,
        paired.n ? `${pct(paired.diffMeanPct)} [${pct(paired.diffCI90[0])}, ${pct(paired.diffCI90[1])}] ${paired.bBetter}/${paired.bWorse} n=${paired.n}` : "n/a",
        paired.n ? pct(paired.bMeanPct) : "n/a",
      ]);
    }
    if (mode === "worst") {
      const best = atSig.sort((a, b) => b.valued!.netPct - a.valued!.netPct).slice(0, 8);
      out.push(`Best entries at the signal (worst-case wicks): ${best.map((r) => `${r.candidate.symbol ?? "?"} ${pct(r.valued!.netPct, 0)}`).join(", ")}`, "");
    }
  }
  out.push(
    table(
      ["wicks", "dates", "candidates", "signal picks better? with - without, at decision", "with signal, at decision", "waiting for it: at signal - at decision (paired)", "with signal, at signal"],
      rows
    )
  );
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
    case "compare": {
      await compareCmd(await getSnapshot(false), flags);
      return;
    }
    case "grid": {
      await gridCmd(await getSnapshot(false), flags);
      return;
    }
    case "filters": {
      await filtersCmd(await getSnapshot(false), flags);
      return;
    }
    case "forensics": {
      await forensicsCmd(await getSnapshot(false), flags);
      return;
    }
    case "stops": {
      await stopsCmd(await getSnapshot(false), flags);
      return;
    }
    case "paper-fidelity": {
      await paperFidelityCmd(await getSnapshot(Boolean(flags["refresh-universe"])), flags);
      return;
    }
    case "signals": {
      await signalsCmd(await getSnapshot(false), flags);
      return;
    }
    case "survivor": {
      await survivorCmd(await getSnapshot(false), flags);
      return;
    }
    case "sizing": {
      await sizingCmd(await getSnapshot(false), flags);
      return;
    }
    default:
      console.log(`usage: tsx scripts/backtest-replay.ts <command> [flags]

  snapshot                     read the candidate universe + actual trades from prod (read-only) into the cache
  fetch [--pass fine|coarse] [--chain c] [--only-traded] [--ids file.json]
                               fill the GeckoTerminal candle cache (~10 req/min, one request per pool per
                               pass). fine: 1m around decision/entry (traded also get 5m); coarse: 5m to +72h
  calibrate [--costs median|p75]
                               measure real fill costs vs candles, save the cost model, and replay our
                               autonomous live trades (as-was rules, v1.8) against what actually happened
  run [--entry at-decision[+Nm]|actual] [--exit v1.8 | --exit-json file] [--chain c] [--status S1,S2]
      [--from iso] [--to iso] [--venue pump.fun|other|dexId] [--include-manual] [--equity 25] [--size-pct 5] [--ref-size usd]
      [--hold-hours 48] [--max-concurrent n] [--costs median|p75] [--intrabar worst|close] [--legacy-steps] [--out name]
                               replay the universe from cache only (never fetches, never writes the DB)
  compare --vs <version | file.json> [--exit v1.8] [run's universe flags]
                               paired per-trade comparison of two exit configs, both intrabar modes, split
                               by path peak (<2x, 2-4x, >=4x), on the universe and on our live trades
  grid --variants V1=a.json,V2=b.json,... [--exit v1.8] [run's universe flags]
                               B2's pre-registered exit grid: paired deltas vs V0 by peak and launch venue,
                               both intrabar modes, and the verdict under the pre-registered rule
  filters [--exits V0=v1.8,V1=file.json] [--chain solana] [--start 21]
                               C's entry filters E1 (no pump.fun launch at >= $50K) and E2 (non-pump only)
                               vs no filter: per-trade stats and a bracket-sized wallet, both wick modes
  forensics --table <C's json> [--exit v1.8]
                               C's pre-registered launch-forensics gates (F1-F4 Solana, R1 RH) judged by
                               replay P&L: kept minus removed with a CI, both wick modes, winners cut
  stops [--chain solana] [--seconds 30]
                               B5: exitRules.stopConfirm S1-S3 vs v1.8's immediate stops, pre-registered rule
  paper-fidelity [--min 30] [--refresh-universe] [--cached]
                               replay each paper strategy's closed positions (read-only paper book) at the
                               paper entry, fill and size, and compare trade by trade: the sim's calibration check
  signals --table <C2 json> [--field firedAt] [--chain solana]
                               C2 signals: do signal candidates do better at decision, and does entering at
                               the signal beat entering at decision (paired)? Both wick modes, date halves
  survivor [--chain solana] [--exit v1.8] [--min-train-trades 15]
                               B3: survivor entries at T+6/12/24h, tuned on the first half of dates and
                               tested on the second, against early entry on the same candidates
  sizing [--exits v1.8,file.json] [--chain solana] [--start 21] [--paths 5000]
                               compounding sweep: user brackets, brackets from 20%, flat 10%, flat 5%`);
  }
}
