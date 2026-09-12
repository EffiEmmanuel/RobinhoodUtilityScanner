import { db } from "../db";
import { logger } from "../logger";
import { LedgerEntryType, TradeStatus } from "../generated/prisma";
import { tradingConfig } from "./config";
import { isTradingEnabled } from "./runtimeState";
import { isLiveModeReady, getWalletGasBalanceEth } from "./live/liveExecutionProvider";
import { fetchMarketForToken, isNativeEthQuoted } from "../dex/client";
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

// Confirmed live 2026-09-12: this used to try exactly ONE token (the single
// most recently active one) and return undefined on any failure — a
// DexScreener rate-limit (documented elsewhere in this codebase as a real,
// recurring issue), or that one token simply not having an ETH-quoted pair
// right then, was enough to fail the whole lookup. getCashUsd's fallback for
// "no rate" is summing historical ledger entries at whatever USD value they
// were recorded at, which does not track ETH's price at all — a real
// wallet holding 0.016 ETH (~$40.42 at the time) was reported as $18.48,
// triggering a false "daily realized loss 37.8%" circuit-breaker trip on a
// day with no such loss. Two independent fixes:
//  1. Try several recently-active tokens, not just one — any single one
//     failing no longer fails the whole lookup.
//  2. Cache the last successful rate. ETH's price does not meaningfully
//     move minute to minute, so reusing a rate that's merely a few minutes
//     stale is far more honest than the ledger-sum fallback, which can be
//     stale by days and silently ignores ETH price movement entirely.
const ETH_PRICE_CANDIDATE_TOKENS = 10;
const ETH_PRICE_CACHE_MAX_AGE_MS = 30 * 60_000;
let cachedEthPriceUsd: { rate: number; at: number } | undefined;

/**
 * A best-effort, current ETH/USD rate derived from Robinhood Chain's own DEX
 * data (not a mainnet-ETH price feed) — this chain's native gas token isn't
 * guaranteed to trade at mainnet parity, so the conversion rate should come
 * from what's actually happening on THIS chain. Undefined only when no fresh
 * rate could be found AND no recent-enough cached one exists either — never a
 * fabricated number, but also no longer this fragile on a single token.
 */
export async function getEthPriceUsd(): Promise<number | undefined> {
  const recentTokens = await db.token.findMany({
    where: { marketSnapshots: { some: {} } },
    orderBy: { lastSeenAt: "desc" },
    take: ETH_PRICE_CANDIDATE_TOKENS,
  });
  for (const token of recentTokens) {
    try {
      const market = await fetchMarketForToken(token.chain, token.address);
      // dex/client.ts's fetchMarketForToken prefers an ETH-quoted primaryPair
      // when one exists, but this token's only pair(s) could all be quoted in
      // something else (a tokenized stock, a stablecoin) — this guard is what
      // actually stops that from being misread as an ETH rate (see
      // executionFacade.ts's deriveEthPriceUsd for the confirmed-live bug this
      // mirrors). Falls through to try the next candidate rather than
      // fabricating a rate from whatever pair it does have.
      const pair = market.primaryPair;
      if (!pair || !isNativeEthQuoted(pair) || !pair.priceUsd || !pair.priceNative || pair.priceNative === 0) continue;
      const rate = pair.priceUsd / pair.priceNative;
      cachedEthPriceUsd = { rate, at: Date.now() };
      return rate;
    } catch {
      continue;
    }
  }
  if (cachedEthPriceUsd && Date.now() - cachedEthPriceUsd.at <= ETH_PRICE_CACHE_MAX_AGE_MS) {
    logger.warn(
      { cachedAt: new Date(cachedEthPriceUsd.at).toISOString(), rate: cachedEthPriceUsd.rate },
      `no fresh ETH/USD rate from any of the ${ETH_PRICE_CANDIDATE_TOKENS} most recently active tokens — reusing the last known rate rather than falling back to the stale ledger sum`
    );
    return cachedEthPriceUsd.rate;
  }
  return undefined;
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

/** All-time realized PnL, summed straight from the ledger — exported for
 * /trading/status's account-health stat card, in addition to its existing
 * use inside recordPortfolioSnapshot. */
export async function getTotalRealizedPnlUsd(): Promise<number> {
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
  // User directive 2026-09-12, needed three times in one night: a manual
  // "count losses from right now, not from midnight" override — POST
  // /trading/reset-circuit-breaker records one of these. Only ever moves the
  // floor FORWARD (a stale reset from a past day is ignored, so this can't
  // accidentally un-scope a boundary that's already correct) and never
  // touches the underlying trade/ledger history, only what these two
  // breakers are willing to count from that point on.
  const lastReset = await db.circuitBreakerReset.findFirst({ orderBy: { resetAt: "desc" } });
  const countingSince = lastReset && lastReset.resetAt > startOfDay ? lastReset.resetAt : startOfDay;

  const todaysPnl = await db.ledgerEntry.findMany({
    where: { type: LedgerEntryType.REALIZED_PNL, occurredAt: { gte: countingSince } },
  });
  const todaysRealizedPnl = todaysPnl.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0);
  const dailyRealizedLossPercent =
    todaysRealizedPnl < 0 && state.totalEquityUsd > 0 ? (Math.abs(todaysRealizedPnl) / state.totalEquityUsd) * 100 : 0;

  // User directive 2026-09-12: scoped to today, the same day boundary as the
  // daily-loss-percent breaker just above — previously this had NO day
  // boundary at all, so a losing streak persisted across days with nothing
  // to clear it but a new win. Confirmed live: 3 losses on 2026-09-11 left
  // this permanently tripped into 2026-09-12 with 0 open positions — no
  // trade could ever close to produce that win while entries stayed paused,
  // a genuine deadlock. A fresh day now means a fresh streak, exactly like
  // the daily-loss check already works. Reads past the normal limit so
  // conservative mode's own, higher consecutive-loss hard stop can see the
  // whole streak — both still bounded to today.
  const recentClosed = await db.trade.findMany({
    where: { status: TradeStatus.CLOSED, closedAt: { gte: countingSince } },
    orderBy: { closedAt: "desc" },
    take: Math.max(tradingConfig.maxConsecutiveLosses, tradingConfig.conservativeHardStopConsecutiveLosses),
    select: { realizedPnlUsd: true },
  });
  const firstNonLoss = recentClosed.findIndex((t) => (t.realizedPnlUsd ?? 0) >= 0);
  const consecutiveLosses = firstNonLoss === -1 ? recentClosed.length : firstNonLoss;

  const { mode, reasons } = resolveEntryMode({ hardPauseReasons, dailyRealizedLossPercent, consecutiveLosses });
  return { paused: mode === "PAUSED", mode, reasons };
}

/**
 * Manual override: the daily-loss and consecutive-loss breakers stop
 * counting anything before now. See checkCircuitBreakers' countingSince and
 * the CircuitBreakerReset model's doc comment for why this exists — a plain
 * API trigger (POST /trading/reset-circuit-breaker), not automatic.
 */
export async function resetCircuitBreakerCounters(reason?: string): Promise<void> {
  await db.circuitBreakerReset.create({ data: { reason } });
  logger.info({ reason }, "circuit-breaker loss counters manually reset — counting from now");
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
