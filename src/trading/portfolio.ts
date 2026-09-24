import { db } from "../db";
import { logger } from "../logger";
import { LedgerEntryType, TradeStatus } from "../generated/prisma";
import { config } from "../config";
import { tradingConfig } from "./config";
import { isTradingEnabled } from "./runtimeState";
import { isLiveModeReady, getWalletGasBalanceEth, quoteEthPriceUsd } from "./live/liveExecutionProvider";
import { fetchMarketForToken, isNativeEthQuoted } from "../dex/client";
import { getJupiterQuote, SOL_MINT } from "./live/solana/jupiterClient";
import { isSolanaWalletConfigured, getSolanaWalletBalanceSol } from "./live/solana/wallet";
import { summarizeError } from "../util/errors";
import { withTimeout } from "../util/http";
import { resolveEntryMode, type EntryMode, type EntryModeResult } from "./conservativeMode";

const LAMPORTS_PER_SOL = 1_000_000_000;
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
  // On-chain first (see quoteEthPriceUsd); the recent-token DexScreener pairs
  // below are the fallback. 10s, not 3s: the first call of a process also
  // finds the ETH/USDG pool (~5s), which is cached from then on.
  try {
    const rate = await withTimeout(quoteEthPriceUsd(), 10_000, "on-chain ETH/USD quote");
    if (rate !== undefined) {
      cachedEthPriceUsd = { rate, at: Date.now() };
      return rate;
    }
  } catch (err) {
    logger.warn({ err: summarizeError(err) }, "on-chain ETH/USD quote failed — falling back to DexScreener pairs");
  }
  const recentTokens = await db.token.findMany({
    where: { marketSnapshots: { some: {} } },
    orderBy: { lastSeenAt: "desc" },
    take: ETH_PRICE_CANDIDATE_TOKENS,
  });
  for (const token of recentTokens) {
    try {
      // Confirmed live 2026-09-16: fetchMarketForToken's own retry/backoff
      // can take 30s+ per candidate under rate-limiting, and this loop tries
      // up to ETH_PRICE_CANDIDATE_TOKENS of them sequentially — unbounded,
      // this hung /trading/status for minutes. Bounding each candidate
      // individually keeps a single slow one from blocking the rest; a
      // timeout is treated exactly like any other fetch failure below.
      const market = await withTimeout(fetchMarketForToken(token.chain, token.address), 3000, "ETH price candidate fetch");
      // ethPair, not primaryPair: the primary pair is the token's deepest pool
      // whatever it's quoted in (a tokenized stock, a stablecoin), and reading
      // that priceNative as an ETH rate is the confirmed-live bug
      // executionFacade.ts's deriveEthPriceUsd guards against. The guard
      // below stays as the load-bearing check. Falls through to try the next
      // candidate rather than fabricating a rate from whatever pair it has.
      const pair = market.ethPair;
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

const SOL_PRICE_CACHE_MAX_AGE_MS = 30 * 60_000;
let cachedSolPriceUsd: { rate: number; at: number } | undefined;

// USDC on Solana — a fixed, always-liquid quote target, not derived from
// whatever tokens happen to be recently active.
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// 1 SOL, in lamports — arbitrary but large enough that Jupiter's route isn't
// dominated by a single pool's minimum-size quirks.
const SOL_PRICE_PROBE_LAMPORTS = 1_000_000_000n;
const USDC_DECIMALS = 6;

/**
 * SOL/USD counterpart to getEthPriceUsd above. Deliberately NOT the same
 * "hunt through recently active tokens' DexScreener pairs" approach —
 * confirmed live 2026-09-16: it never once succeeded that way. Robinhood
 * Chain's recently-active tokens trade directly against ETH, but Solana's
 * most recently discovered tokens are fresh pump.fun launches, which
 * essentially never have a clean SOL-quoted DexScreener pair — so that
 * loop always exhausted all 10 candidates and cost 30s+ per call for
 * nothing. Asking Jupiter for a direct SOL->USDC quote is fast (sub-second,
 * verified live), reliable, and doesn't depend on any particular token's
 * data being available.
 */
export async function getSolPriceUsd(): Promise<number | undefined> {
  try {
    const quote = await withTimeout(getJupiterQuote(SOL_MINT, USDC_MINT, SOL_PRICE_PROBE_LAMPORTS, 50), 5000, "SOL/USDC price quote");
    if (quote && quote.inAmount > 0n) {
      const solAmount = Number(quote.inAmount) / LAMPORTS_PER_SOL;
      const usdcAmount = Number(quote.outAmount) / 10 ** USDC_DECIMALS;
      const rate = usdcAmount / solAmount;
      cachedSolPriceUsd = { rate, at: Date.now() };
      return rate;
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "SOL/USDC price quote failed");
  }
  if (cachedSolPriceUsd && Date.now() - cachedSolPriceUsd.at <= SOL_PRICE_CACHE_MAX_AGE_MS) {
    logger.warn(
      { cachedAt: new Date(cachedSolPriceUsd.at).toISOString(), rate: cachedSolPriceUsd.rate },
      "no fresh SOL/USD rate from Jupiter — reusing the last known rate"
    );
    return cachedSolPriceUsd.rate;
  }
  return undefined;
}

/**
 * Synchronous, non-blocking reads of the cached rates above — for any caller
 * that's on a latency-sensitive path (dashboard requests, and critically,
 * checkCircuitBreakers()/getPortfolioState() run before every real trade
 * entry). Confirmed live 2026-09-16: getEthPriceUsd's own live-fetch-then-
 * fallback logic can still take 30s+ in the worst case even with the
 * per-candidate timeout, since ALL 10 candidates can fail — that's too slow
 * to sit on the entry-decision critical path, not just the dashboard. These
 * never trigger a fetch themselves; PRICE_REFRESH_INTERVAL_MS below keeps
 * the cache warm in the background instead. Undefined only on a cold cache
 * (nothing fetched successfully yet this process) — callers already have
 * their own documented fallback for that (see getCashUsd).
 */
export function getCachedEthPriceUsd(): number | undefined {
  return cachedEthPriceUsd?.rate;
}
export function getCachedSolPriceUsd(): number | undefined {
  return cachedSolPriceUsd?.rate;
}

const PRICE_REFRESH_INTERVAL_MS = 90_000;
// Explicitly called from orchestrator.ts's startTradingOrchestrator, same as
// ensurePaperWalletSeeded — deliberately NOT invoked at module scope. A
// module-level side effect here would fire on every import, including from
// the test suite (which shares this environment's DATABASE_URL), triggering
// a real DB query and leaving a dangling setInterval with nothing to clear it.
export function startBackgroundPriceRefresh(): void {
  const refresh = () => {
    void getEthPriceUsd().catch((err) => logger.warn({ err: String(err) }, "background ETH/USD price refresh failed"));
    void getSolPriceUsd().catch((err) => logger.warn({ err: String(err) }, "background SOL/USD price refresh failed"));
  };
  refresh(); // populate the cache immediately on startup rather than waiting a full interval
  setInterval(refresh, PRICE_REFRESH_INTERVAL_MS);
}

/** True only when Solana trading is both enabled AND actually has a signer configured. */
function isSolanaLiveReady(): boolean {
  return config.solanaTradingEnabled && isSolanaWalletConfigured();
}

/**
 * In LIVE mode, cash comes from the REAL on-chain wallet balance(s), not
 * summed historical ledger entries — confirmed live: the ledger sums each
 * entry's amountUsd at the USD rate captured when that entry was recorded
 * (e.g. the initial deposit), which drifts from reality as the gas token's
 * price moves and never self-corrects. The real wallet balance is always
 * current by definition. PAPER/SHADOW has no real wallet, so the ledger sum
 * is the only option there (and is authoritative for a simulation anyway).
 *
 * Solana fix (2026-09-18, prerequisite for SOLANA_TRADING_ENABLED=true with
 * real capital): this used to read ONLY the EVM wallet, even once Solana
 * trades were live — a completely separate wallet's balance, and every
 * BUY/SELL/GAS ledger entry Solana trades record, both went uncounted. Two
 * physically separate wallets means their cash has to be summed explicitly;
 * there is no single "the wallet" to read anymore once both are live. Each
 * side's failure to read is treated as $0 for THIS reading (never a stale
 * ledger guess) — for a system sizing real trades and running loss breakers
 * off this number, undercounting equity (more conservative sizing, breakers
 * trip sooner) is the safe failure direction; overcounting is not.
 */
async function getCashUsd(
  ethPriceUsd: number | undefined,
  solPriceUsd: number | undefined
): Promise<{ cashUsd: number; cashEth: number | undefined; cashSol: number | undefined }> {
  const evmLive = isLiveModeReady();
  const solanaLive = isSolanaLiveReady();

  if (!evmLive && !solanaLive) {
    const entries = await db.ledgerEntry.findMany({ where: { type: { in: CASH_MOVEMENT_TYPES } } });
    return { cashUsd: entries.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0), cashEth: undefined, cashSol: undefined };
  }

  let cashEth: number | undefined;
  let cashSol: number | undefined;
  let evmUsd = 0;
  let solUsd = 0;

  if (evmLive) {
    try {
      cashEth = await getWalletGasBalanceEth();
      if (ethPriceUsd !== undefined) {
        evmUsd = cashEth * ethPriceUsd;
      } else if (!solanaLive) {
        // Solo-EVM behavior, unchanged from before the Solana fix: no price
        // yet to convert a known real balance, so fall back to the ledger
        // sum rather than reporting the EVM side as $0.
        const entries = await db.ledgerEntry.findMany({ where: { type: { in: CASH_MOVEMENT_TYPES } } });
        return { cashUsd: entries.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0), cashEth, cashSol: undefined };
      } else {
        logger.warn("live EVM wallet balance read but no current ETH/USD rate available — EVM cash omitted from this reading");
      }
    } catch (err) {
      if (!solanaLive) {
        logger.warn({ err: String(err) }, "failed to read live EVM wallet balance — cashUsd falls back to ledger sum");
        const entries = await db.ledgerEntry.findMany({ where: { type: { in: CASH_MOVEMENT_TYPES } } });
        return { cashUsd: entries.reduce((sum, e) => sum + (e.amountUsd ?? 0), 0), cashEth: undefined, cashSol: undefined };
      }
      logger.warn({ err: String(err) }, "failed to read live EVM wallet balance — EVM cash omitted from this reading");
    }
  }

  if (solanaLive) {
    try {
      cashSol = await getSolanaWalletBalanceSol();
      if (solPriceUsd !== undefined) {
        solUsd = cashSol * solPriceUsd;
      } else {
        logger.warn("live Solana wallet balance read but no current SOL/USD rate available — Solana cash omitted from this reading");
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "failed to read live Solana wallet balance — Solana cash omitted from this reading");
    }
  }

  return { cashUsd: evmUsd + solUsd, cashEth, cashSol };
}

async function getOpenPositionValueUsd(chain?: string): Promise<{ valueUsd: number; costBasisUsd: number; openCount: number }> {
  const openTrades = await db.trade.findMany({
    where: {
      status: { in: [TradeStatus.OPEN, TradeStatus.PARTIALLY_EXITED] },
      ...(chain ? { token: { chain } } : {}),
    },
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
  cashSol?: number;
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
  // Current conversion rates (see getEthPriceUsd/getSolPriceUsd) so any USD
  // figure above can be displayed in native-token terms too — undefined only
  // when no current rate is available; callers should fall back to USD-only
  // display, never fabricate a rate.
  ethPriceUsd?: number;
  solPriceUsd?: number;
}

export async function getPortfolioState(): Promise<PortfolioState> {
  // Synchronous cached reads, not live fetches — this runs on the real
  // trade-entry critical path via checkCircuitBreakers(), not just the
  // dashboard. See getCachedEthPriceUsd/getCachedSolPriceUsd's doc comment.
  const ethPriceUsd = getCachedEthPriceUsd();
  const solPriceUsd = getCachedSolPriceUsd();
  const [{ cashUsd, cashEth, cashSol }, positions, lockedProfitUsd] = await Promise.all([
    getCashUsd(ethPriceUsd, solPriceUsd),
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
    cashSol,
    openPositionValueUsd: positions.valueUsd,
    totalEquityUsd,
    lockedProfitUsd,
    reserveTargetUsd,
    deployableCapUsd,
    deployedUsd: positions.costBasisUsd,
    availableToDeployUsd,
    openPositionCount: positions.openCount,
    ethPriceUsd,
    solPriceUsd,
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

export interface ChainPortfolioStats {
  chain: string;
  openPositionCount: number;
  openPositionValueUsd: number;
  deployedUsd: number;
  unrealizedPnlUsd: number;
  // Summed straight from Trade.realizedPnlUsd (each trade carries its own
  // token -> chain), NOT from the ledger — the ledger's REALIZED_PNL entries
  // (see getTotalRealizedPnlUsd above) have no chain column and are the
  // authoritative all-chain total, but this is the one figure that CAN
  // honestly be split per chain, so it exists only for that.
  realizedPnlUsd: number;
  closedTradeCount: number;
}

async function getChainStats(chain: string): Promise<ChainPortfolioStats> {
  const [{ valueUsd, costBasisUsd, openCount }, closedAgg] = await Promise.all([
    getOpenPositionValueUsd(chain),
    db.trade.aggregate({
      where: { status: TradeStatus.CLOSED, token: { chain } },
      _sum: { realizedPnlUsd: true },
      _count: { _all: true },
    }),
  ]);
  return {
    chain,
    openPositionCount: openCount,
    openPositionValueUsd: valueUsd,
    deployedUsd: costBasisUsd,
    unrealizedPnlUsd: valueUsd - costBasisUsd,
    realizedPnlUsd: closedAgg._sum.realizedPnlUsd ?? 0,
    closedTradeCount: closedAgg._count._all,
  };
}

/** Per-chain position/PnL breakdown for the dashboard's chain panels —
 * unlike PortfolioState above (one shared cash/equity pool by design), this
 * is genuinely splittable straight from Trade rows. */
export async function getPortfolioByChain(): Promise<ChainPortfolioStats[]> {
  return Promise.all([getChainStats("robinhood"), getChainStats("solana")]);
}

/** §25 account circuit breakers — checked before every new entry. */
export interface CircuitBreakerResult {
  // True only when no new entry may open at all. A tripped LOSS breaker
  // normally gives mode CONSERVATIVE instead, where this stays false and
  // entries go through the high-conviction gate (see conservativeMode.ts).
  // These three fields fold every chain's gas/balance check together, same
  // as always — kept as-is for the dashboard and anything else that just
  // wants one overall status. Use `chains` below for an actual entry
  // decision on a specific chain.
  paused: boolean;
  mode: EntryMode;
  reasons: string[];
  // Confirmed live 2026-09-23: a Solana RPC quota outage's "could not check
  // Solana wallet balance" failure was landing in the one shared reasons list
  // above, which paused the top-level mode for BOTH chains — a healthy Robinhood
  // wallet had no way to keep trading while only Solana's RPC was broken.
  // Global reasons (kill switch, position cap, loss breakers) still apply to
  // every chain; only the two chain-specific gas/balance checks are scoped
  // here so one chain's infra problem can't block the other's entries.
  chains: Record<"robinhood" | "solana", EntryModeResult>;
}

export async function checkCircuitBreakers(): Promise<CircuitBreakerResult> {
  // Genuinely global — apply to every chain no matter what.
  const globalHardPauseReasons: string[] = [];

  if (!isTradingEnabled()) {
    globalHardPauseReasons.push("global kill switch is engaged");
  }

  const state = await getPortfolioState();
  // maxOpenPositions <= 0 means no count cap (see config.ts) — total real
  // risk still stays bounded by maxTotalDeployedPercent/maxSinglePositionPercent
  // below, this only ever limited how many *positions* could be open at once,
  // not how much capital could be at risk.
  if (tradingConfig.maxOpenPositions > 0 && state.openPositionCount >= tradingConfig.maxOpenPositions) {
    globalHardPauseReasons.push(`max open positions reached (${state.openPositionCount}/${tradingConfig.maxOpenPositions})`);
  }

  // §30 — LIVE only. Exits stay possible even with low gas (checked
  // separately by validateExit, never gated here), only new entries pause.
  // Scoped per chain below (see `chains`) — confirmed live 2026-09-23 that
  // sharing one list with the EVM check meant a Solana RPC outage paused
  // Robinhood entries too, even with a perfectly healthy EVM wallet.
  const chainHardPauseReasons: Record<"robinhood" | "solana", string[]> = { robinhood: [], solana: [] };

  if (isSolanaLiveReady()) {
    try {
      const solGasBalance = await getSolanaWalletBalanceSol();
      if (solGasBalance < tradingConfig.minGasBalanceSol) {
        chainHardPauseReasons.solana.push(`Solana wallet balance ${solGasBalance.toFixed(4)} SOL is below ${tradingConfig.minGasBalanceSol} SOL minimum`);
      }
    } catch (err) {
      chainHardPauseReasons.solana.push(`could not check Solana wallet balance: ${summarizeError(err)}`);
    }
  }

  if (isLiveModeReady()) {
    try {
      const gasBalance = await getWalletGasBalanceEth();
      if (gasBalance < tradingConfig.minGasBalanceEth) {
        chainHardPauseReasons.robinhood.push(`wallet gas balance ${gasBalance.toFixed(5)} ETH is below ${tradingConfig.minGasBalanceEth} ETH minimum`);
      }
    } catch (err) {
      chainHardPauseReasons.robinhood.push(`could not check wallet gas balance: ${summarizeError(err)}`);
    }
  }

  const { dailyRealizedLossPercent, consecutiveLosses } = await getLossBreakerCounts(state.totalEquityUsd);
  const lossInput = { dailyRealizedLossPercent, consecutiveLosses };

  // Top-level result — every reason folded together, exactly like before
  // this change, for the dashboard and anything else that just wants one
  // overall status.
  const allHardPauseReasons = [...globalHardPauseReasons, ...chainHardPauseReasons.robinhood, ...chainHardPauseReasons.solana];
  const { mode, reasons } = resolveEntryMode({ hardPauseReasons: allHardPauseReasons, ...lossInput });

  const chains = {
    robinhood: resolveEntryMode({ hardPauseReasons: [...globalHardPauseReasons, ...chainHardPauseReasons.robinhood], ...lossInput }),
    solana: resolveEntryMode({ hardPauseReasons: [...globalHardPauseReasons, ...chainHardPauseReasons.solana], ...lossInput }),
  };

  return { paused: mode === "PAUSED", mode, reasons, chains };
}

/**
 * The daily-realized-loss-percent and consecutive-loss counts that feed
 * resolveEntryMode's two LOSS breakers — the exact arithmetic checkCircuitBreakers
 * uses, extracted so a cheaper caller (api.ts's dashboard "why no trades"
 * snapshot, which can't afford checkCircuitBreakers' own getPortfolioState/gas
 * RPC calls) can reuse the real day-boundary/reset-scoping/streak logic
 * instead of re-deriving it — that reimplementation had already drifted once
 * (see the 2026-09-16 review) after the "scope to today" fix below only
 * landed here.
 */
export async function getLossBreakerCounts(equityUsd: number): Promise<{ dailyRealizedLossPercent: number; consecutiveLosses: number }> {
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
  const dailyRealizedLossPercent = todaysRealizedPnl < 0 && equityUsd > 0 ? (Math.abs(todaysRealizedPnl) / equityUsd) * 100 : 0;

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

  return { dailyRealizedLossPercent, consecutiveLosses };
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
