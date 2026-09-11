import { db } from "../db";
import { logger } from "../logger";
import { LedgerEntryType, TradeStatus } from "../generated/prisma";
import { tradingConfig } from "./config";
import { isTradingEnabled } from "./runtimeState";
import { isLiveModeReady, getWalletGasBalanceEth } from "./live/liveExecutionProvider";
import { fetchMarketForToken } from "../dex/client";
import { summarizeError } from "../util/errors";
import { resolveEntryMode, type EntryMode } from "./conservativeMode";

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

/**
 * A best-effort, current ETH/USD rate derived from Robinhood Chain's own DEX
 * data (not a mainnet-ETH price feed) — this chain's native gas token isn't
 * guaranteed to trade at mainnet parity, so the conversion rate should come
 * from what's actually happening on THIS chain. Picks whatever token was
 * most recently active and re-fetches its live pair fresh (priceUsd/
 * priceNative implies the native-token rate, same derivation executionFacade.ts
 * already uses for live trade sizing) — undefined if nothing is available,
 * never a stale/fabricated number.
 */
export async function getEthPriceUsd(): Promise<number | undefined> {
  const recentToken = await db.token.findFirst({
    where: { marketSnapshots: { some: {} } },
    orderBy: { lastSeenAt: "desc" },
  });
  if (!recentToken) return undefined;
  try {
    const market = await fetchMarketForToken(recentToken.chain, recentToken.address);
    const pair = market.primaryPair;
    if (!pair?.priceUsd || !pair?.priceNative || pair.priceNative === 0) return undefined;
    return pair.priceUsd / pair.priceNative;
  } catch {
    return undefined;
  }
}

/**
 * In LIVE mode, cash comes from the REAL on-chain wallet balance, not summed
 * historical ledger entries — confirmed live: the ledger sums each entry's
 * amountUsd at the USD rate captured when that entry was recorded (e.g. the
 * initial deposit), which drifts from reality as ETH's price moves and never
 * self-corrects. The real wallet balance is always current by definition.
 * PAPER/SHADOW has no real wallet, so the ledger sum is the only option there
 * (and is authoritative for a simulation anyway).
 */
async function getCashUsd(ethPriceUsd: number | undefined): Promise<{ cashUsd: number; cashEth: number | undefined }> {
  if (isLiveModeReady()) {
    try {
      const cashEth = await getWalletGasBalanceEth();
      if (ethPriceUsd !== undefined) return { cashUsd: cashEth * ethPriceUsd, cashEth };
      // Real balance known, but no current price to convert it — fall back
      // to the ledger sum for the USD figure rather than reporting $0.
      logger.warn("live wallet balance read but no current ETH/USD rate available — cashUsd falls back to ledger sum");
    } catch (err) {
      logger.warn({ err: String(err) }, "failed to read live wallet balance — cashUsd falls back to ledger sum");
    }
  }
  const entries = await db.ledgerEntry.findMany({ where: { type: { in: CASH_MOVEMENT_TYPES } } });
  return { cashUsd: entries.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0), cashEth: undefined };
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

/**
 * Sum of every PROFIT_RESERVE skim (see positionManager.ts's executeSell) —
 * always recorded as a negative amountUsd, so the absolute value is the
 * running total locked away. Reads directly from the ledger regardless of
 * LIVE/PAPER mode, unlike cash itself (see getCashUsd) — this figure is
 * subtracted from equity below before ANY deployable/reserve math runs, not
 * folded into CASH_MOVEMENT_TYPES, because in LIVE mode cash comes from the
 * real wallet balance and would otherwise never reflect it at all.
 */
async function getLockedProfitUsd(): Promise<number> {
  const entries = await db.ledgerEntry.findMany({ where: { type: LedgerEntryType.PROFIT_RESERVE } });
  return Math.abs(entries.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0));
}

export interface PortfolioState {
  cashUsd: number;
  cashEth?: number;
  openPositionValueUsd: number;
  totalEquityUsd: number;
  // Cumulative profit skimmed into the lockbox (see getLockedProfitUsd) —
  // already real money, already part of totalEquityUsd above, but excluded
  // from reserveTargetUsd/deployableCapUsd/availableToDeployUsd below so it
  // can never be sized against again.
  lockedProfitUsd: number;
  reserveTargetUsd: number;
  deployableCapUsd: number;
  deployedUsd: number;
  availableToDeployUsd: number;
  openPositionCount: number;
  // A current conversion rate (see getEthPriceUsd) so any USD figure above
  // can be displayed as its ETH equivalent too — ETH fluctuates, so a
  // dashboard showing only a point-in-time USD number reads as more stable
  // and precise than reality. Undefined when no current rate is available;
  // callers should fall back to USD-only display, never fabricate a rate.
  ethPriceUsd?: number;
}

export async function getPortfolioState(): Promise<PortfolioState> {
  const ethPriceUsd = await getEthPriceUsd();
  const [{ cashUsd, cashEth }, positions, lockedProfitUsd] = await Promise.all([
    getCashUsd(ethPriceUsd),
    getOpenPositionValueUsd(),
    getLockedProfitUsd(),
  ]);
  const totalEquityUsd = cashUsd + positions.valueUsd;
  // Profit lockbox (user directive 2026-09-11): reserve/deployable/available
  // are computed off equity minus whatever's already been banked, so a
  // losing streak can't eat back into gains already locked in — this is
  // what actually enforces the lock (LIVE mode's cash comes straight from
  // the wallet and would otherwise never reflect it, see getCashUsd).
  // totalEquityUsd itself stays the honest, unreduced total — this is a
  // ledger-level lock on what the sizing formula will deploy against, not a
  // claim that the money has physically left the wallet.
  const deployableEquityUsd = Math.max(0, totalEquityUsd - lockedProfitUsd);
  const reserveTargetUsd = deployableEquityUsd * (tradingConfig.minReservePercent / 100);
  const deployableCapUsd = deployableEquityUsd * (tradingConfig.maxTotalDeployedPercent / 100);
  const availableToDeployUsd = Math.max(0, deployableCapUsd - positions.costBasisUsd);

  return {
    cashUsd,
    cashEth,
    openPositionValueUsd: positions.valueUsd,
    totalEquityUsd,
    lockedProfitUsd,
    reserveTargetUsd,
    deployableCapUsd,
    deployedUsd: positions.costBasisUsd,
    availableToDeployUsd,
    openPositionCount: positions.openCount,
    ethPriceUsd,
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
  // True only when no new entry may open at all. A tripped LOSS breaker
  // normally gives mode CONSERVATIVE instead, where this stays false and
  // entries go through the high-conviction gate (see conservativeMode.ts).
  paused: boolean;
  mode: EntryMode;
  reasons: string[];
}

export async function checkCircuitBreakers(): Promise<CircuitBreakerResult> {
  const hardPauseReasons: string[] = [];

  if (!isTradingEnabled()) {
    hardPauseReasons.push("global kill switch is engaged");
  }

  const state = await getPortfolioState();
  // maxOpenPositions <= 0 means no count cap (see config.ts) — total real
  // risk still stays bounded by maxTotalDeployedPercent/maxSinglePositionPercent
  // below, this only ever limited how many *positions* could be open at once,
  // not how much capital could be at risk.
  if (tradingConfig.maxOpenPositions > 0 && state.openPositionCount >= tradingConfig.maxOpenPositions) {
    hardPauseReasons.push(`max open positions reached (${state.openPositionCount}/${tradingConfig.maxOpenPositions})`);
  }

  // §30 — LIVE only. Exits stay possible even with low gas (checked
  // separately by validateExit, never gated here), only new entries pause.
  if (isLiveModeReady()) {
    try {
      const gasBalance = await getWalletGasBalanceEth();
      if (gasBalance < tradingConfig.minGasBalanceEth) {
        hardPauseReasons.push(`wallet gas balance ${gasBalance.toFixed(5)} ETH is below ${tradingConfig.minGasBalanceEth} ETH minimum`);
      }
    } catch (err) {
      hardPauseReasons.push(`could not check wallet gas balance: ${summarizeError(err)}`);
    }
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todaysPnl = await db.ledgerEntry.findMany({
    where: { type: LedgerEntryType.REALIZED_PNL, occurredAt: { gte: startOfDay } },
  });
  const todaysRealizedPnl = todaysPnl.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0);
  const dailyRealizedLossPercent =
    todaysRealizedPnl < 0 && state.totalEquityUsd > 0 ? (Math.abs(todaysRealizedPnl) / state.totalEquityUsd) * 100 : 0;

  // Reads past the normal limit so conservative mode's own, higher
  // consecutive-loss hard stop can see the whole streak.
  const recentClosed = await db.trade.findMany({
    where: { status: TradeStatus.CLOSED },
    orderBy: { closedAt: "desc" },
    take: Math.max(tradingConfig.maxConsecutiveLosses, tradingConfig.conservativeHardStopConsecutiveLosses),
    select: { realizedPnlUsd: true },
  });
  const firstNonLoss = recentClosed.findIndex((t) => (t.realizedPnlUsd ?? 0) >= 0);
  const consecutiveLosses = firstNonLoss === -1 ? recentClosed.length : firstNonLoss;

  const { mode, reasons } = resolveEntryMode({ hardPauseReasons, dailyRealizedLossPercent, consecutiveLosses });
  return { paused: mode === "PAUSED", mode, reasons };
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
