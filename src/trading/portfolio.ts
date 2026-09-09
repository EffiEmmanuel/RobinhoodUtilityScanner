import { db } from "../db";
import { logger } from "../logger";
import { LedgerEntryType, TradeStatus } from "../generated/prisma";
import { tradingConfig } from "./config";
import { isTradingEnabled } from "./runtimeState";
import { isLiveModeReady, getWalletGasBalanceEth } from "./live/liveExecutionProvider";

const PAPER_WALLET_ADDRESS = "paper";

/**
 * Cash is derived purely from DEPOSIT/WITHDRAWAL/BUY/SELL/GAS ledger entries.
 * REALIZED_PNL entries are informational only (reporting/circuit-breaker
 * checks) — counting them toward cash too would double-count the same money
 * that BUY/SELL already moved.
 */
const CASH_MOVEMENT_TYPES = [
  LedgerEntryType.DEPOSIT,
  LedgerEntryType.WITHDRAWAL,
  LedgerEntryType.BUY,
  LedgerEntryType.SELL,
  LedgerEntryType.GAS,
  LedgerEntryType.MANUAL_ADJUSTMENT,
];

/** Ensures the paper wallet has its one-time seed deposit recorded. Idempotent. */
export async function ensurePaperWalletSeeded(): Promise<void> {
  const existing = await db.ledgerEntry.findFirst({ where: { type: LedgerEntryType.DEPOSIT } });
  if (existing) return;
  await db.ledgerEntry.create({
    data: {
      type: LedgerEntryType.DEPOSIT,
      amountUsd: tradingConfig.paperStartingBalanceUsd,
      notes: "paper trading seed balance",
      occurredAt: new Date(),
    },
  });
  logger.info({ amount: tradingConfig.paperStartingBalanceUsd }, "seeded paper trading balance");
}

async function getCashUsd(): Promise<number> {
  const entries = await db.ledgerEntry.findMany({ where: { type: { in: CASH_MOVEMENT_TYPES } } });
  return entries.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0);
}

async function getOpenPositionValueUsd(): Promise<{ valueUsd: number; costBasisUsd: number; openCount: number }> {
  const openTrades = await db.trade.findMany({
    where: { status: { in: [TradeStatus.OPEN, TradeStatus.PARTIALLY_EXITED] } },
    include: { snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
  });
  let valueUsd = 0;
  let costBasisUsd = 0;
  for (const t of openTrades) {
    const latest = t.snapshots[0];
    const remainingTokens = latest?.tokenAmountRemaining ?? t.entryTokenAmount ?? 0;
    const price = latest?.priceUsd ?? t.entryPriceUsd ?? 0;
    valueUsd += remainingTokens * price;
    costBasisUsd += t.positionSizeUsd;
  }
  return { valueUsd, costBasisUsd, openCount: openTrades.length };
}

export interface PortfolioState {
  cashUsd: number;
  openPositionValueUsd: number;
  totalEquityUsd: number;
  reserveTargetUsd: number;
  deployableCapUsd: number;
  deployedUsd: number;
  availableToDeployUsd: number;
  openPositionCount: number;
}

export async function getPortfolioState(): Promise<PortfolioState> {
  const [cashUsd, positions] = await Promise.all([getCashUsd(), getOpenPositionValueUsd()]);
  const totalEquityUsd = cashUsd + positions.valueUsd;
  const reserveTargetUsd = totalEquityUsd * (tradingConfig.minReservePercent / 100);
  const deployableCapUsd = totalEquityUsd * (tradingConfig.maxTotalDeployedPercent / 100);
  const availableToDeployUsd = Math.max(0, deployableCapUsd - positions.costBasisUsd);

  return {
    cashUsd,
    openPositionValueUsd: positions.valueUsd,
    totalEquityUsd,
    reserveTargetUsd,
    deployableCapUsd,
    deployedUsd: positions.costBasisUsd,
    availableToDeployUsd,
    openPositionCount: positions.openCount,
  };
}

export async function recordPortfolioSnapshot(state?: PortfolioState): Promise<void> {
  const s = state ?? (await getPortfolioState());
  await db.portfolioSnapshot.create({
    data: {
      walletAddress: PAPER_WALLET_ADDRESS,
      cashValueUsd: s.cashUsd,
      openPositionValueUsd: s.openPositionValueUsd,
      totalEquityUsd: s.totalEquityUsd,
      realizedPnlUsd: await getTotalRealizedPnlUsd(),
      unrealizedPnlUsd: s.openPositionValueUsd - s.deployedUsd,
      reserveUsd: s.reserveTargetUsd,
      deployableUsd: s.availableToDeployUsd,
    },
  });
}

async function getTotalRealizedPnlUsd(): Promise<number> {
  const entries = await db.ledgerEntry.findMany({ where: { type: LedgerEntryType.REALIZED_PNL } });
  return entries.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0);
}

/** §25 account circuit breakers — checked before every new entry. */
export interface CircuitBreakerResult {
  paused: boolean;
  reasons: string[];
}

export async function checkCircuitBreakers(): Promise<CircuitBreakerResult> {
  const reasons: string[] = [];

  if (!isTradingEnabled()) {
    reasons.push("global kill switch is engaged");
  }

  const state = await getPortfolioState();
  if (state.openPositionCount >= tradingConfig.maxOpenPositions) {
    reasons.push(`max open positions reached (${state.openPositionCount}/${tradingConfig.maxOpenPositions})`);
  }

  // §30 — LIVE only. Exits stay possible even with low gas (checked
  // separately by validateExit, never gated here), only new entries pause.
  if (isLiveModeReady()) {
    try {
      const gasBalance = await getWalletGasBalanceEth();
      if (gasBalance < tradingConfig.minGasBalanceEth) {
        reasons.push(`wallet gas balance ${gasBalance.toFixed(5)} ETH is below ${tradingConfig.minGasBalanceEth} ETH minimum`);
      }
    } catch (err) {
      reasons.push(`could not check wallet gas balance: ${String(err)}`);
    }
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todaysPnl = await db.ledgerEntry.findMany({
    where: { type: LedgerEntryType.REALIZED_PNL, occurredAt: { gte: startOfDay } },
  });
  const todaysRealizedPnl = todaysPnl.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0);
  if (todaysRealizedPnl < 0 && state.totalEquityUsd > 0) {
    const lossPercent = (Math.abs(todaysRealizedPnl) / state.totalEquityUsd) * 100;
    if (lossPercent >= tradingConfig.maxDailyRealizedLossPercent) {
      reasons.push(`daily realized loss ${lossPercent.toFixed(1)}% >= ${tradingConfig.maxDailyRealizedLossPercent}% limit`);
    }
  }

  const recentClosed = await db.trade.findMany({
    where: { status: TradeStatus.CLOSED },
    orderBy: { closedAt: "desc" },
    take: tradingConfig.maxConsecutiveLosses,
  });
  if (
    recentClosed.length === tradingConfig.maxConsecutiveLosses &&
    recentClosed.every((t) => (t.realizedPnlUsd ?? 0) < 0)
  ) {
    reasons.push(`${tradingConfig.maxConsecutiveLosses} consecutive losses`);
  }

  return { paused: reasons.length > 0, reasons };
}

export async function recordLedgerEntry(input: {
  type: LedgerEntryType;
  tradeId?: string;
  amountUsd: number;
  notes?: string;
  occurredAt?: Date;
}): Promise<void> {
  await db.ledgerEntry.create({
    data: {
      type: input.type,
      tradeId: input.tradeId,
      amountUsd: input.amountUsd,
      notes: input.notes,
      occurredAt: input.occurredAt ?? new Date(),
    },
  });
}
