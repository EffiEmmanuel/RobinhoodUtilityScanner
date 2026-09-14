import { db } from "../db";
import { logger } from "../logger";
import type { ExitRules } from "./strategy";

/**
 * §69/§70 — replays REAL Trade + PositionSnapshot history (never synthetic
 * data) under a candidate exit-rules configuration. The replay walks forward
 * through each trade's ACTUAL historical snapshot sequence in timestamp
 * order, deciding exits using only that snapshot and earlier ones — this is
 * what "no lookahead" means here: at simulated decision point N, only
 * snapshots 0..N are visible, exactly like the real position monitor.
 *
 * This can only backtest exit-rule variations on trades that were actually
 * opened (they're the only rows with real PositionSnapshot history). It
 * cannot yet simulate "what if we'd traded a candidate we skipped" — that
 * would need price history as granular as PositionSnapshot for untraded
 * candidates, which CandidateOutcome's 15m/1h/6h/24h/48h checkpoints don't
 * provide. Documented as a known gap, not silently approximated.
 */

interface SimulatedExit {
  multiple: number;
  exitReason: string;
  holdingMinutes: number;
  mfePercent: number;
  maePercent: number;
}

function simulateExitUnderRules(
  entryPriceUsd: number,
  openedAt: Date,
  snapshots: { priceUsd: number | null; capturedAt: Date }[],
  exitRules: ExitRules
): SimulatedExit {
  let profitStepsTaken = 0;
  let remainingFraction = 1;
  let realizedMultiple = 0;
  let peakMultiple = 1;
  let mfePercent = 0;
  let maePercent = 0;
  let exitReason = "held to end of available history";
  let holdingMinutes = 0;

  for (const snap of snapshots) {
    if (snap.priceUsd === null || entryPriceUsd <= 0) continue;
    const multiple = snap.priceUsd / entryPriceUsd;
    const pnlPercent = (multiple - 1) * 100;
    peakMultiple = Math.max(peakMultiple, multiple);
    mfePercent = Math.max(mfePercent, pnlPercent);
    maePercent = Math.min(maePercent, pnlPercent);
    holdingMinutes = (snap.capturedAt.getTime() - openedAt.getTime()) / 60_000;

    const nextStep = exitRules.profitSteps[profitStepsTaken];
    if (nextStep && multiple >= nextStep.multiple) {
      const sellFraction = remainingFraction * (nextStep.sellPercentOfRemaining / 100);
      realizedMultiple += sellFraction * multiple;
      remainingFraction -= sellFraction;
      profitStepsTaken++;
      exitReason = `profit target ${nextStep.multiple}x`;
    }

    if (remainingFraction > 0 && multiple >= exitRules.trailingActivationMultiple) {
      const retracePercent = ((peakMultiple - multiple) / peakMultiple) * 100;
      if (retracePercent >= exitRules.trailingPercent) {
        realizedMultiple += remainingFraction * multiple;
        remainingFraction = 0;
        exitReason = `trailing exit (retraced ${retracePercent.toFixed(1)}% from ${peakMultiple.toFixed(2)}x peak)`;
        break;
      }
    }

    if (remainingFraction > 0 && (pnlPercent <= -exitRules.catastrophicLossPercent || pnlPercent <= -exitRules.maxLossPercent)) {
      realizedMultiple += remainingFraction * multiple;
      remainingFraction = 0;
      exitReason = pnlPercent <= -exitRules.catastrophicLossPercent ? "catastrophic loss" : "max loss";
      break;
    }

    if (remainingFraction > 0 && holdingMinutes >= exitRules.maxHoldMinutes) {
      realizedMultiple += remainingFraction * multiple;
      remainingFraction = 0;
      exitReason = "time exit";
      break;
    }
  }

  if (remainingFraction > 0) {
    const last = snapshots[snapshots.length - 1];
    const lastMultiple = last?.priceUsd && entryPriceUsd > 0 ? last.priceUsd / entryPriceUsd : 1;
    realizedMultiple += remainingFraction * lastMultiple;
  }

  return { multiple: realizedMultiple, exitReason, holdingMinutes, mfePercent, maePercent };
}

export interface BacktestInput {
  exitRules: ExitRules;
  fromDate: Date;
  toDate: Date;
  strategyVersionId?: string;
}

export async function runBacktest(input: BacktestInput) {
  const trades = await db.trade.findMany({
    where: { status: "CLOSED", closedAt: { gte: input.fromDate, lte: input.toDate }, entryPriceUsd: { not: null } },
    include: { snapshots: { orderBy: { capturedAt: "asc" } } },
  });

  if (trades.length === 0) {
    logger.warn({ fromDate: input.fromDate, toDate: input.toDate }, "backtest: no closed trades in this range");
  }

  const replayed = trades.map((trade) => {
    const sim = simulateExitUnderRules(trade.entryPriceUsd ?? 0, trade.openedAt ?? trade.createdAt, trade.snapshots, input.exitRules);
    return {
      tradeId: trade.id,
      actualMultiple: trade.realizedMultiple ?? undefined,
      actualExitReason: trade.exitReason ?? undefined,
      simulatedMultiple: sim.multiple,
      simulatedExitReason: sim.exitReason,
      simulatedHoldingMinutes: sim.holdingMinutes,
      simulatedMfePercent: sim.mfePercent,
      simulatedMaePercent: sim.maePercent,
    };
  });

  const returns = replayed.map((r) => (r.simulatedMultiple - 1) * 100);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const sorted = [...returns].sort((a, b) => a - b);

  const winRate = returns.length > 0 ? wins.length / returns.length : undefined;
  const averageReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : undefined;
  const medianReturn = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : undefined;
  const maxDrawdown = replayed.length > 0 ? Math.min(...replayed.map((r) => r.simulatedMaePercent)) : undefined;
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : undefined;
  const expectancy = averageReturn;
  const avgHoldingMinutes = replayed.length > 0 ? replayed.reduce((a, r) => a + r.simulatedHoldingMinutes, 0) / replayed.length : undefined;
  const hit2xRate = replayed.length > 0 ? replayed.filter((r) => r.simulatedMultiple >= 2).length / replayed.length : undefined;
  const hit25xRate = replayed.length > 0 ? replayed.filter((r) => r.simulatedMultiple >= 2.5).length / replayed.length : undefined;
  const avgMfePercent = replayed.length > 0 ? replayed.reduce((a, r) => a + r.simulatedMfePercent, 0) / replayed.length : undefined;
  const avgMaePercent = replayed.length > 0 ? replayed.reduce((a, r) => a + r.simulatedMaePercent, 0) / replayed.length : undefined;

  const run = await db.backtestRun.create({
    data: {
      strategyVersionId: input.strategyVersionId,
      scope: "EXIT_RULES",
      configuration: input.exitRules as unknown as object,
      fromDate: input.fromDate,
      toDate: input.toDate,
      totalTrades: replayed.length,
      winRate,
      averageReturn,
      medianReturn,
      maxDrawdown,
      profitFactor,
      expectancy,
      avgHoldingMinutes,
      hit2xRate,
      hit25xRate,
      avgMfePercent,
      avgMaePercent,
      tradesReplayed: replayed as unknown as object,
      notes:
        replayed.length < 10
          ? `Only ${replayed.length} historical trades available — treat this result as illustrative, not statistically meaningful (see PRD §66 data thresholds).`
          : undefined,
    },
  });

  logger.info({ backtestId: run.id, totalTrades: replayed.length, winRate, averageReturn }, "backtest complete");
  return run;
}

export interface EntryBacktestRules {
  minLiquidityUsd: number;
  minHourlyTxns: number;
  minBuyRatio1h: number;
  maxBuyRatio1h: number;
  maxVolumeToLiquidity1h: number;
  maxRecentRunUpPercent: number;
  lookbackMinutes: number;
}

export interface EntryBacktestInput {
  rules: EntryBacktestRules;
  fromDate: Date;
  toDate: Date;
  strategyVersionId?: string;
}

function snapshotPassesEntryRules(
  snap: {
    marketCapUsd: number | null;
    liquidityUsd: number | null;
    volume1h: number | null;
    buys1h: number | null;
    sells1h: number | null;
    capturedAt: Date;
  },
  prior: { marketCapUsd: number | null }[],
  rules: EntryBacktestRules
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const txns = (snap.buys1h ?? 0) + (snap.sells1h ?? 0);
  const buyRatio = txns > 0 ? (snap.buys1h ?? 0) / txns : undefined;
  const volToLiq = snap.liquidityUsd && snap.liquidityUsd > 0 && snap.volume1h !== null ? snap.volume1h / snap.liquidityUsd : undefined;
  const mcaps = prior.map((p) => p.marketCapUsd).filter((m): m is number => m !== null && m > 0);
  const low = Math.min(...mcaps, snap.marketCapUsd ?? Infinity);
  const runUp = snap.marketCapUsd && Number.isFinite(low) && low > 0 ? (snap.marketCapUsd / low - 1) * 100 : 0;

  if ((snap.liquidityUsd ?? 0) < rules.minLiquidityUsd) reasons.push(`liquidity < ${rules.minLiquidityUsd}`);
  if (txns < rules.minHourlyTxns) reasons.push(`hourly txns < ${rules.minHourlyTxns}`);
  if (buyRatio === undefined || buyRatio < rules.minBuyRatio1h) reasons.push(`buy ratio < ${rules.minBuyRatio1h}`);
  if (buyRatio !== undefined && buyRatio > rules.maxBuyRatio1h) reasons.push(`buy ratio > ${rules.maxBuyRatio1h}`);
  if (volToLiq === undefined || volToLiq > rules.maxVolumeToLiquidity1h) reasons.push(`volume/liquidity > ${rules.maxVolumeToLiquidity1h}`);
  if (runUp > rules.maxRecentRunUpPercent) reasons.push(`recent run-up ${runUp.toFixed(1)}% > ${rules.maxRecentRunUpPercent}%`);
  return { passed: reasons.length === 0, reasons };
}

export async function runEntryBacktest(input: EntryBacktestInput) {
  const candidates = await db.tradeCandidate.findMany({
    where: { createdAt: { gte: input.fromDate, lte: input.toDate } },
    include: {
      token: { include: { marketSnapshots: { orderBy: { capturedAt: "asc" } } } },
      outcome: true,
    },
  });

  const replayed = candidates.map((candidate) => {
    const snapshots = candidate.token.marketSnapshots.filter(
      (s) => s.capturedAt >= candidate.createdAt && s.capturedAt <= new Date(candidate.createdAt.getTime() + 48 * 3_600_000)
    );
    let entry:
      | {
          snapshotId: string;
          capturedAt: Date;
          marketCapUsd: number;
          reasons: string[];
        }
      | undefined;
    let lastReasons: string[] = ["no snapshots"];

    for (const snap of snapshots) {
      if (snap.marketCapUsd === null) continue;
      const priorCutoff = new Date(snap.capturedAt.getTime() - input.rules.lookbackMinutes * 60_000);
      const prior = snapshots.filter((s) => s.capturedAt >= priorCutoff && s.capturedAt <= snap.capturedAt);
      const check = snapshotPassesEntryRules(snap, prior, input.rules);
      lastReasons = check.reasons;
      if (check.passed) {
        entry = { snapshotId: snap.id, capturedAt: snap.capturedAt, marketCapUsd: snap.marketCapUsd, reasons: ["entry rules passed"] };
        break;
      }
    }

    const afterEntry = entry ? snapshots.filter((s) => s.capturedAt >= entry!.capturedAt && s.marketCapUsd !== null) : [];
    const mcaps = afterEntry.map((s) => s.marketCapUsd as number);
    const maxMultiple = entry && mcaps.length ? Math.max(...mcaps) / entry.marketCapUsd : undefined;
    const minMultiple = entry && mcaps.length ? Math.min(...mcaps) / entry.marketCapUsd : undefined;
    return {
      candidateId: candidate.id,
      tokenId: candidate.tokenId,
      status: candidate.status,
      tradeLane: candidate.tradeLane,
      qualificationPath: candidate.qualificationPath,
      simulatedEntry: entry,
      skippedReason: entry ? undefined : lastReasons,
      maxMultipleAfterEntry: maxMultiple,
      minMultipleAfterEntry: minMultiple,
      actualTraded: candidate.outcome?.traded ?? false,
      actualHit2x: candidate.outcome?.hit200x ?? false,
      actualHit10x: candidate.outcome?.hit1000x ?? false,
      actualHit100x: candidate.outcome?.hit10000x ?? false,
    };
  });

  const entries = replayed.filter((r) => r.simulatedEntry);
  const returns = entries.map((r) => ((r.maxMultipleAfterEntry ?? 1) - 1) * 100);
  const averageReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : undefined;
  const hit2xRate = entries.length ? entries.filter((r) => (r.maxMultipleAfterEntry ?? 0) >= 2).length / entries.length : undefined;
  const hit25xRate = entries.length ? entries.filter((r) => (r.maxMultipleAfterEntry ?? 0) >= 2.5).length / entries.length : undefined;
  const maxDrawdown = entries.length ? Math.min(...entries.map((r) => ((r.minMultipleAfterEntry ?? 1) - 1) * 100)) : undefined;

  const run = await db.backtestRun.create({
    data: {
      strategyVersionId: input.strategyVersionId,
      scope: "ENTRY_RULES",
      configuration: input.rules as unknown as object,
      fromDate: input.fromDate,
      toDate: input.toDate,
      totalTrades: entries.length,
      winRate: entries.length ? entries.filter((r) => (r.maxMultipleAfterEntry ?? 0) > 1).length / entries.length : undefined,
      averageReturn,
      maxDrawdown,
      hit2xRate,
      hit25xRate,
      tradesReplayed: replayed as unknown as object,
      notes: `Entry-rule backtest over ${candidates.length} candidates using stored MarketSnapshot history. This estimates entry eligibility only; it does not simulate live quote fills or exits.`,
    },
  });
  logger.info({ backtestId: run.id, candidates: candidates.length, simulatedEntries: entries.length, hit2xRate }, "entry backtest complete");
  return run;
}
