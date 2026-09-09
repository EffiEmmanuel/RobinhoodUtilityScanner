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
