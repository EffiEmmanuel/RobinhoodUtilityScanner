import { parseEther, formatUnits } from "viem";
import { PublicKey } from "@solana/web3.js";
import { logger } from "../logger";
import { config } from "../config";
import { sleep } from "../util/http";
import type { MarketPair } from "../dex/types";
import { isNativeEthQuoted } from "../dex/client";
import { tradingConfig } from "./config";
import { getPaperQuote, getPaperSellQuote, isSellQuoteAvailable as isPaperSellQuoteAvailable, type PaperQuote } from "./execution";
import { isLiveModeReady, executeLiveBuy, executeLiveSell, getLiveQuote } from "./live/liveExecutionProvider";
import type { PoolKey } from "./live/poolDiscovery";
import { getPublicClient, getWalletAddress } from "./live/wallet";
import { getTokenDecimals, getTokenBalance } from "./live/tokenUtils";
import { ensureSellApprovals, ensureSwapRouter02Approval } from "./live/permit2Approvals";
import { recordExecutionQuality } from "./executionQuality";
import {
  isSolanaLiveModeReady,
  getSolanaLiveQuote,
  executeSolanaLiveBuy,
  executeSolanaLiveSell,
  canSolanaWalletTransferToken,
  closeEmptySolanaTokenAccount,
  type TokenAccountCloseResult,
} from "./live/solana/executionProvider";
import { getSolanaConnection, getSolanaWalletPublicKey } from "./live/solana/wallet";
import { getSolanaMintDecimals, getSolanaTokenBalance, sellAmountRaw } from "./live/solana/tokenUtils";
import { SOL_MINT } from "./live/solana/jupiterClient";
import { getSolPriceUsd, getCachedEthPriceUsd } from "./portfolio";

const LAMPORTS_PER_SOL = 1_000_000_000;

// Solana counterpart to isNativeEthQuoted/deriveEthPriceUsd below — same
// rationale (never misread a pair quoted in something else as a native-token
// rate), just keyed on wSOL's mint instead of the EVM zero address.
export function isNativeSolQuoted(pair: Pick<MarketPair, "quoteTokenAddress">): boolean {
  return pair.quoteTokenAddress === SOL_MINT;
}

function deriveSolPriceUsd(pair: Pick<MarketPair, "priceUsd" | "priceNative" | "quoteTokenAddress">): number | undefined {
  if (!isNativeSolQuoted(pair)) return undefined;
  if (!pair.priceUsd || !pair.priceNative || pair.priceNative === 0) return undefined;
  return pair.priceUsd / pair.priceNative;
}

/**
 * The one seam entryMonitor.ts and positionManager.ts call through — neither
 * of them know or care whether a fill is simulated or real. Swapping modes
 * (SHADOW <-> LIVE) never requires touching the trading-loop logic, only this
 * file and config.
 */
export interface FillResult extends PaperQuote {
  provider: "paper" | "live";
  // Plain string, not `0x${string}` — Solana transaction signatures are
  // base58, not EVM hex. Nothing outside the EVM branch below needs the
  // narrower type; every downstream consumer (notifications, ledger notes,
  // logging) only ever stores/displays this.
  txHash?: string;
  approvalTxHashes?: string[];
  // Live EVM buys only: gas of the background sell pre-approval, in USD,
  // resolving once it confirms (0 if none was needed or it failed). Kept off
  // the buy's critical path — see attachPendingApprovalGas.
  pendingApprovalGasUsd?: Promise<number>;
  // Live Solana fills only: how gasCostUsd breaks down (fees, token-account
  // rent paid or refunded), stored on the TradeExecution as rawReceipt.
  receipt?: SolanaFillReceipt;
}

/**
 * Network costs of a live Solana fill, in lamports. gasCostUsd carries them
 * net: a buy that opens a new token account pays its rent (a real cost of
 * the trade until refunded); closing the account after a full exit gets the
 * rent back (closeTokenAccountAfterFullExit), which the caller books against
 * that last sell, so its gasCostUsd can go negative. Summed over the trade,
 * the rent cancels when the close succeeds and stays a cost when it doesn't
 * — the same as the wallet sees it.
 */
export interface SolanaFillReceipt {
  feeLamports?: number;
  rentLamports?: number;
  closeSignature?: string;
  closeFeeLamports?: number;
  rentRefundLamports?: number;
  closeSkippedReason?: string;
}

/** Ledger note for a fill's GAS entry, naming any token-account rent in it. */
export function gasLedgerNote(fill: Pick<FillResult, "provider" | "receipt">): string {
  if (fill.provider !== "live") return "simulated gas";
  const r = fill.receipt;
  if (r?.rentLamports) return `real gas, incl. ${r.rentLamports} lamports token-account rent (refunded if the account is closed after the exit)`;
  if (r?.rentRefundLamports) return `token account closed after the exit: ${r.rentRefundLamports} lamports rent refunded, ${r.closeFeeLamports ?? 0} lamports fee (${r.closeSignature})`;
  return "real gas";
}

async function sumGasCostWei(client: ReturnType<typeof getPublicClient>, hashes: string[]): Promise<bigint> {
  const receipts = await Promise.all(hashes.map((hash) => client.waitForTransactionReceipt({ hash: hash as `0x${string}` })));
  return receipts.reduce((sum, r) => sum + r.gasUsed * r.effectiveGasPrice, 0n);
}

type CallFrame = { to?: string; value?: string; calls?: CallFrame[] };

/** Native ETH the wallet received inside one transaction, from its call
 * trace. Unlike a before/after balance read, nothing else the wallet does at
 * the same moment can leak into it. */
async function getEthReceivedFromTrace(client: ReturnType<typeof getPublicClient>, hash: `0x${string}`, wallet: string): Promise<bigint> {
  const trace = (await (client.request as (args: { method: string; params: unknown[] }) => Promise<unknown>)({
    method: "debug_traceTransaction",
    params: [hash, { tracer: "callTracer" }],
  })) as CallFrame;
  const target = wallet.toLowerCase();
  const walk = (frame: CallFrame, top: boolean): bigint =>
    (!top && frame.to?.toLowerCase() === target && frame.value ? BigInt(frame.value) : 0n) +
    (frame.calls ?? []).reduce((sum, child) => sum + walk(child, false), 0n);
  return walk(trace, true);
}

// Confirmed live 2026-09-11: OPAI's primaryPair was quoted in QQQ (a
// tokenized stock) with $30K liquidity, dwarfing its real $1.2K ETH pair.
// priceUsd/priceNative on that pair is USD-per-QQQ, not USD-per-ETH — reading
// it as an ETH rate sized a live buy ~3.6x over (spent ~$12.60 while
// recording $3.55). dex/client.ts now prefers an ETH-quoted primaryPair when
// one exists at all, but this is the load-bearing check: refuse outright
// rather than silently derive a wrong rate from whatever pair was passed in.
function deriveEthPriceUsd(pair: Pick<MarketPair, "priceUsd" | "priceNative" | "quoteTokenAddress">): number | undefined {
  if (!isNativeEthQuoted(pair)) return undefined;
  if (!pair.priceUsd || !pair.priceNative || pair.priceNative === 0) return undefined;
  return pair.priceUsd / pair.priceNative;
}

// Multi-hop routing (live/routing.ts) means a token no longer needs a
// native-ETH pair to be tradeable — one that only trades against USDG or a
// tokenized stock has no pair to derive an ETH rate from, so fall back to the
// process-wide rate portfolio.ts keeps warm (itself derived only from
// genuinely ETH-quoted pairs, never a stock/stable-quoted one).
function ethPriceUsdFor(pair: Pick<MarketPair, "priceUsd" | "priceNative" | "quoteTokenAddress">): number | undefined {
  return deriveEthPriceUsd(pair) ?? getCachedEthPriceUsd();
}

// Anything past this is almost certainly not "this token is just thin" —
// legitimate liquidity doesn't produce impact in the hundreds of percent for
// a normal position size. Confirmed live: a quote came back at 432% impact
// with zero visibility into which pool caused it. Threshold is deliberately
// well above the real 3%/300bps trading caps (defaultMaxBuySlippageBps /
// maxBuyPriceImpactPercent) so this only fires for the genuinely broken
// cases, not routine rejections.
const SUSPICIOUS_PRICE_IMPACT_PERCENT = 25;

function logSuspiciousQuote(
  direction: "buy" | "sell",
  tokenAddress: string,
  quote: { poolKey?: PoolKey; poolId: string; poolLiquidity?: bigint; routeLabel?: string },
  priceImpactPercent: number,
  spotPriceUsd: number,
  effectivePriceUsd: number
): void {
  if (priceImpactPercent < SUSPICIOUS_PRICE_IMPACT_PERCENT) return;
  logger.warn(
    {
      direction,
      tokenAddress,
      priceImpactPercent,
      spotPriceUsd,
      effectivePriceUsd,
      route: quote.routeLabel,
      poolId: quote.poolId,
      fee: quote.poolKey?.fee,
      tickSpacing: quote.poolKey?.tickSpacing,
      hooks: quote.poolKey?.hooks,
      poolLiquidity: quote.poolLiquidity?.toString(),
    },
    "quote has suspiciously high price impact — likely quoted against the wrong pool or one with too little real depth"
  );
}

/**
 * Quote-only — never executes anything, even in LIVE mode (a real on-chain
 * `eth_call` simulation via the Quoter, not a transaction). This is what
 * entry/exit revalidation checks slippage/price-impact against *before*
 * deciding whether to actually call executeBuyFill/executeSellFill (§17: a
 * fresh quote must exist and be acceptable before a real buy is ever signed).
 */
export async function getBuyEstimate(
  tokenAddress: string,
  positionSizeUsd: number,
  pair: MarketPair,
  chain: string
): Promise<Pick<PaperQuote, "estimatedSlippageBps" | "estimatedPriceImpactPercent" | "tokenAmount">> {
  const liveReady = chain === "solana" ? isSolanaLiveModeReady() : isLiveModeReady();
  if (!liveReady) {
    const quote = getPaperQuote(positionSizeUsd, pair);
    void recordExecutionQuality({
      tokenAddress,
      chain,
      pair,
      direction: "QUOTE_BUY",
      success: true,
      slippageBps: quote.estimatedSlippageBps,
      priceImpactPercent: quote.estimatedPriceImpactPercent,
      suspiciousQuote: quote.estimatedPriceImpactPercent >= SUSPICIOUS_PRICE_IMPACT_PERCENT,
    });
    return quote;
  }

  if (chain === "solana") {
    // Confirmed live 2026-09-21: deriveSolPriceUsd only works when THIS
    // token's own pair happens to be SOL-quoted — but plenty of real, liquid
    // tokens' primary/only DexScreener pair is quoted in something else
    // (DOJO's is DOGE-quoted, for example, despite $37K liquidity and a
    // perfectly good Jupiter route). Giving up there returned tokenAmount: 0,
    // which downstream made isSellable() fall back to a 1-lamport dust probe
    // — too small for Jupiter to route at all (HTTP 400) — misread as "no
    // sell path," permanently blocking a real, tradeable token. SOL/USD is a
    // single global rate independent of any one token's pair data, so fall
    // back to the same reliable, cached Jupiter SOL/USDC probe portfolio.ts
    // already uses for exactly this reason (see its doc comment) rather than
    // refusing to price the trade at all.
    const solPriceUsd = deriveSolPriceUsd(pair) ?? (await getSolPriceUsd());
    if (!solPriceUsd) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, tokenAmount: 0 };
    const amountInLamports = BigInt(Math.floor((positionSizeUsd / solPriceUsd) * LAMPORTS_PER_SOL));
    const quote = await getSolanaLiveQuote(tokenAddress, true, amountInLamports, tradingConfig.defaultMaxBuySlippageBps);
    if (!quote) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, tokenAmount: 0 };

    const decimals = await getSolanaMintDecimals(getSolanaConnection(), new PublicKey(tokenAddress));
    const tokenOut = Number(quote.outAmount) / 10 ** decimals;
    const effectivePriceUsd = tokenOut > 0 ? positionSizeUsd / tokenOut : Infinity;
    const spotPriceUsd = pair.priceUsd ?? effectivePriceUsd;
    const priceImpactPercent = spotPriceUsd > 0 ? Math.max(0, ((effectivePriceUsd - spotPriceUsd) / spotPriceUsd) * 100) : 0;
    void recordExecutionQuality({
      tokenAddress,
      chain,
      pair,
      direction: "QUOTE_BUY",
      success: true,
      slippageBps: Math.round(priceImpactPercent * 100),
      priceImpactPercent,
      suspiciousQuote: priceImpactPercent >= SUSPICIOUS_PRICE_IMPACT_PERCENT,
    });
    return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent, tokenAmount: tokenOut };
  }

  const ethPriceUsd = ethPriceUsdFor(pair);
  if (!ethPriceUsd) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, tokenAmount: 0 };
  const amountInWei = parseEther((positionSizeUsd / ethPriceUsd).toFixed(18));
  const quote = await getLiveQuote(tokenAddress as `0x${string}`, true, amountInWei);
  if (!quote) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, tokenAmount: 0 };

  const decimals = await getTokenDecimals(getPublicClient(), tokenAddress as `0x${string}`);
  const tokenOut = Number(formatUnits(quote.amountOut, decimals));
  const effectivePriceUsd = tokenOut > 0 ? positionSizeUsd / tokenOut : Infinity;
  const spotPriceUsd = pair.priceUsd ?? effectivePriceUsd;
  const priceImpactPercent = spotPriceUsd > 0 ? Math.max(0, ((effectivePriceUsd - spotPriceUsd) / spotPriceUsd) * 100) : 0;
  logSuspiciousQuote("buy", tokenAddress, quote, priceImpactPercent, spotPriceUsd, effectivePriceUsd);
  void recordExecutionQuality({
    tokenAddress,
    chain,
    pair,
    direction: "QUOTE_BUY",
    success: true,
    slippageBps: Math.round(priceImpactPercent * 100),
    priceImpactPercent,
    suspiciousQuote: priceImpactPercent >= SUSPICIOUS_PRICE_IMPACT_PERCENT,
  });
  return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent, tokenAmount: tokenOut };
}

export async function executeBuyFill(
  tokenAddress: string,
  positionSizeUsd: number,
  pair: MarketPair,
  chain: string,
  options: { maxSlippageBps?: number } = {}
): Promise<FillResult> {
  const liveReady = chain === "solana" ? isSolanaLiveModeReady() : isLiveModeReady();
  if (!liveReady) {
    const fill = { ...getPaperQuote(positionSizeUsd, pair), provider: "paper" as const };
    void recordExecutionQuality({
      tokenAddress,
      chain,
      pair,
      direction: "BUY",
      success: true,
      slippageBps: fill.estimatedSlippageBps,
      priceImpactPercent: fill.estimatedPriceImpactPercent,
    });
    return fill;
  }

  if (chain === "solana") return executeSolanaBuyFill(tokenAddress, positionSizeUsd, pair, chain, options);

  const ethPriceUsd = ethPriceUsdFor(pair);
  if (!ethPriceUsd) throw new Error("cannot determine ETH/USD price for live buy sizing (missing priceNative)");
  const ethAmount = positionSizeUsd / ethPriceUsd;
  const amountInWei = parseEther(ethAmount.toFixed(18));

  const client = getPublicClient();
  const wallet = getWalletAddress();
  const token = tokenAddress as `0x${string}`;
  // Independent of executeLiveBuy's own quote/simulate/send chain — read in
  // parallel with it starting rather than serially in front of it, shaving
  // one RPC round-trip off buy latency.
  const [balanceBefore, result] = await Promise.all([
    getTokenBalance(client, token, wallet),
    executeLiveBuy(token, amountInWei, options.maxSlippageBps ?? tradingConfig.defaultMaxBuySlippageBps),
  ]);
  const receipt = await client.waitForTransactionReceipt({ hash: result.txHash });
  if (receipt.status !== "success") throw new Error(`live buy transaction reverted on-chain: ${result.txHash}`);

  // Confirmed live: right after a successful receipt, a balanceOf read can
  // still come back showing the pre-buy balance (RPC read-after-write lag —
  // the node answering this eth_call hasn't caught up to the block the
  // receipt came from yet). Recording that as "bought 0 tokens" is worse than
  // any transient failure: it silently fabricates a trade with no tokens and,
  // downstream, the position monitor treats 0-remaining as "already sold" and
  // closes it as a full loss even though the buy — and the tokens — are real
  // (confirmed live 2026-09-11: STONKBROKER trade cmtw8ki67000r1ymz88bfg13o).
  // A revert is already ruled out above, so retry the read a few times before
  // accepting a delta this suspicious.
  const BALANCE_READ_BACKOFF_MS = [0, 1500, 3000, 6000];
  let balanceAfter = await getTokenBalance(client, token, wallet);
  for (let attempt = 0; balanceAfter <= balanceBefore && attempt < BALANCE_READ_BACKOFF_MS.length; attempt++) {
    await sleep(BALANCE_READ_BACKOFF_MS[attempt]);
    balanceAfter = await getTokenBalance(client, token, wallet);
  }
  if (balanceAfter <= balanceBefore) {
    throw new Error(
      `live buy tx ${result.txHash} confirmed on-chain but balanceOf still shows no tokens received after retries — likely an RPC read-after-write lag, not a real 0-token fill; refusing to record a phantom buy. Verify the wallet's actual token balance and reconcile manually.`
    );
  }

  const decimals = await getTokenDecimals(client, token);
  const boughtRaw = balanceAfter - balanceBefore;
  const tokenAmount = Number(formatUnits(boughtRaw, decimals));
  const gasCostEth = Number(formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18));
  const gasCostUsd = gasCostEth * ethPriceUsd;

  logger.info({ tokenAddress, txHash: result.txHash, tokenAmount, gasCostUsd }, "live buy confirmed");
  void recordExecutionQuality({ tokenAddress, chain, pair, direction: "BUY", success: true, slippageBps: 0, priceImpactPercent: 0 });

  // Desk review D8: Permit2 approvals were only ever requested at SELL time,
  // so a stop-loss or profit-target exit had to wait on 1-2 approval
  // transactions (and their own receipts) before the actual sell could even
  // be signed — pure latency added to exactly the moment speed matters most.
  // Fire-and-forget here: best-effort, never blocks or fails the buy that
  // already succeeded, and ensureSellApprovals is idempotent (a no-op if
  // already sufficient) so this only ever saves time, never duplicates work.
  // Approvals are still short-lived (see permit2Approvals.ts's TTL) — a
  // position held past that just re-approves at sell time exactly as before,
  // no regression for long holds, but every fast flip (most of today's
  // trades closed within minutes) now exits without an approval on the
  // critical path at all.
  // Pre-approve for the router a sell of this position will most likely use:
  // the same venue it was bought through (SwapRouter02 for v2/v3 pools).
  const preApproval = result.venue === "v4" ? ensureSellApprovals(token, boughtRaw) : ensureSwapRouter02Approval(token, boughtRaw);
  preApproval.catch((err) =>
    logger.warn({ tokenAddress, err: String(err) }, "pre-approving this position for a future sell failed — will retry at sell time instead")
  );
  const pendingApprovalGasUsd = preApproval
    .then(async (hashes) => Number(formatUnits(await sumGasCostWei(client, hashes), 18)) * ethPriceUsd)
    .catch(() => 0);

  return {
    priceUsd: tokenAmount > 0 ? positionSizeUsd / tokenAmount : 0,
    tokenAmount,
    estimatedSlippageBps: 0, // realized, not estimated — the real fill already happened
    estimatedPriceImpactPercent: 0,
    gasCostUsd,
    provider: "live",
    txHash: result.txHash,
    approvalTxHashes: result.approvalTxHashes,
    pendingApprovalGasUsd,
  };
}

/** Solana branch of executeBuyFill — same balance-delta-based fill accounting
 * as the EVM path above (never trust the swap result's own "amount out" as
 * the recorded fill; read the wallet's actual before/after balance), just
 * against an ATA instead of an ERC20 balanceOf, and no approval step (SPL
 * has no allowance model — Jupiter's transaction already handles ATA
 * creation). Same read-after-write retry as the EVM path — see below. */
async function executeSolanaBuyFill(
  tokenAddress: string,
  positionSizeUsd: number,
  pair: MarketPair,
  chain: string,
  options: { maxSlippageBps?: number }
): Promise<FillResult> {
  // See getBuyEstimate's matching comment: a real, liquid token can still
  // have a non-SOL-quoted primary pair (DOJO/DOGE, confirmed live
  // 2026-09-21) — fall back to the independent, cached SOL/USD rate rather
  // than refusing to size the trade.
  const solPriceUsd = deriveSolPriceUsd(pair) ?? (await getSolPriceUsd());
  if (!solPriceUsd) throw new Error("cannot determine SOL/USD price for live buy sizing (missing priceNative)");
  const amountInLamports = BigInt(Math.floor((positionSizeUsd / solPriceUsd) * LAMPORTS_PER_SOL));

  const conn = getSolanaConnection();
  const wallet = getSolanaWalletPublicKey();
  const mint = new PublicKey(tokenAddress);

  const balanceBefore = await getSolanaTokenBalance(conn, mint, wallet);
  const result = await executeSolanaLiveBuy(tokenAddress, amountInLamports, options.maxSlippageBps ?? tradingConfig.defaultMaxBuySlippageBps);
  // Confirmed live 2026-09-24 (.agent, DESKS x2): the swap confirmed and the
  // tokens landed, but a single balance read straight after confirmation
  // still saw no token account (the swap itself creates the ATA, and the
  // RPC node answering the read hadn't caught up). Throwing there rejected
  // the candidate and left real tokens in the wallet with no Trade — nothing
  // managing an exit — and a manual buy-and-hold's retry bought a second
  // time. Retry the read before accepting a delta this suspicious.
  const BALANCE_READ_BACKOFF_MS = [0, 1500, 3000, 6000];
  let balanceAfter = await getSolanaTokenBalance(conn, mint, wallet);
  for (let attempt = 0; balanceAfter <= balanceBefore && attempt < BALANCE_READ_BACKOFF_MS.length; attempt++) {
    await sleep(BALANCE_READ_BACKOFF_MS[attempt]);
    balanceAfter = await getSolanaTokenBalance(conn, mint, wallet);
  }
  if (balanceAfter <= balanceBefore) {
    throw new Error(
      `live solana buy tx ${result.signature} confirmed but the wallet's token balance didn't increase — refusing to record a phantom buy. Verify the wallet's actual token balance and reconcile manually.`
    );
  }

  const decimals = await getSolanaMintDecimals(conn, mint);
  const boughtRaw = balanceAfter - balanceBefore;
  const tokenAmount = Number(boughtRaw) / 10 ** decimals;
  const gasCostSol = ((result.feeLamports ?? 0) + (result.rentLamports ?? 0)) / LAMPORTS_PER_SOL;
  const gasCostUsd = gasCostSol * solPriceUsd;

  logger.info({ tokenAddress, signature: result.signature, tokenAmount, gasCostUsd, rentLamports: result.rentLamports }, "live solana buy confirmed");
  void recordExecutionQuality({ tokenAddress, chain, pair, direction: "BUY", success: true, slippageBps: 0, priceImpactPercent: 0 });

  return {
    priceUsd: tokenAmount > 0 ? positionSizeUsd / tokenAmount : 0,
    tokenAmount,
    estimatedSlippageBps: 0,
    estimatedPriceImpactPercent: 0,
    gasCostUsd,
    provider: "live",
    txHash: result.signature,
    receipt: { feeLamports: result.feeLamports, rentLamports: result.rentLamports },
  };
}

/**
 * Sell-side counterpart to getBuyEstimate — quote-only, never executes.
 * Also positionManager.ts's source of truth for mark-to-market pricing on an
 * open position (user directive 2026-09-12): DexScreener's pair.priceUsd is
 * what the entry/exit-decision AI and the deterministic stop/profit checks
 * used to price against, and it can lag a real collapse — confirmed live
 * 2026-09-11, Sheared showed +329% unrealized off pair.priceUsd while an
 * on-chain quote for the same size would have shown it was already losing,
 * so its -15% stop never got a chance to fire. priceUsd here is 0 in every
 * failure branch (no quote, no ETH rate) — callers must treat 0 as "no mark
 * available" and fall back, never as a real $0 price.
 */
export async function getSellEstimate(
  tokenAddress: string,
  tokenAmount: number,
  pair: MarketPair,
  chain: string
): Promise<Pick<PaperQuote, "estimatedSlippageBps" | "estimatedPriceImpactPercent" | "priceUsd">> {
  const liveReady = chain === "solana" ? isSolanaLiveModeReady() : isLiveModeReady();
  if (!liveReady) {
    const quote = getPaperSellQuote(tokenAmount, pair);
    void recordExecutionQuality({
      tokenAddress,
      chain,
      pair,
      direction: "QUOTE_SELL",
      success: quote.priceUsd > 0,
      slippageBps: quote.estimatedSlippageBps,
      priceImpactPercent: quote.estimatedPriceImpactPercent,
      suspiciousQuote: quote.estimatedPriceImpactPercent >= SUSPICIOUS_PRICE_IMPACT_PERCENT,
      error: quote.priceUsd > 0 ? undefined : "paper sell quote unavailable",
    });
    return quote;
  }

  if (chain === "solana") {
    const decimals = await getSolanaMintDecimals(getSolanaConnection(), new PublicKey(tokenAddress));
    const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));
    const quote = await getSolanaLiveQuote(tokenAddress, false, tokenAmountRaw, tradingConfig.defaultMaxSellSlippageBps);
    if (!quote) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, priceUsd: 0 };

    const solPriceUsd = deriveSolPriceUsd(pair);
    if (!solPriceUsd) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, priceUsd: 0 };
    const proceedsUsd = (Number(quote.outAmount) / LAMPORTS_PER_SOL) * solPriceUsd;
    const effectivePriceUsd = tokenAmount > 0 ? proceedsUsd / tokenAmount : 0;
    const spotPriceUsd = pair.priceUsd ?? effectivePriceUsd;
    const priceImpactPercent = spotPriceUsd > 0 ? Math.max(0, ((spotPriceUsd - effectivePriceUsd) / spotPriceUsd) * 100) : 0;
    void recordExecutionQuality({
      tokenAddress,
      chain,
      pair,
      direction: "QUOTE_SELL",
      success: true,
      slippageBps: Math.round(priceImpactPercent * 100),
      priceImpactPercent,
      suspiciousQuote: priceImpactPercent >= SUSPICIOUS_PRICE_IMPACT_PERCENT,
    });
    return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent, priceUsd: effectivePriceUsd };
  }

  const client = getPublicClient();
  const token = tokenAddress as `0x${string}`;
  const decimals = await getTokenDecimals(client, token);
  const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));
  // Must quote the SAME venue the real sell will use (exits may route through
  // a predatory-fee pool when it's the only one) — otherwise the slippage
  // guard is judging a pool we'd never actually trade through.
  const quote = await getLiveQuote(token, false, tokenAmountRaw, { allowHighFeePools: true });
  if (!quote) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, priceUsd: 0 };

  const ethPriceUsd = ethPriceUsdFor(pair);
  if (!ethPriceUsd) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, priceUsd: 0 };
  const proceedsUsd = Number(formatUnits(quote.amountOut, 18)) * ethPriceUsd;
  const effectivePriceUsd = tokenAmount > 0 ? proceedsUsd / tokenAmount : 0;
  const spotPriceUsd = pair.priceUsd ?? effectivePriceUsd;
  const priceImpactPercent = spotPriceUsd > 0 ? Math.max(0, ((spotPriceUsd - effectivePriceUsd) / spotPriceUsd) * 100) : 0;
  logSuspiciousQuote("sell", tokenAddress, quote, priceImpactPercent, spotPriceUsd, effectivePriceUsd);
  void recordExecutionQuality({
    tokenAddress,
    chain,
    pair,
    direction: "QUOTE_SELL",
    success: true,
    slippageBps: Math.round(priceImpactPercent * 100),
    priceImpactPercent,
    suspiciousQuote: priceImpactPercent >= SUSPICIOUS_PRICE_IMPACT_PERCENT,
  });
  return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent, priceUsd: effectivePriceUsd };
}

/** `fullExit`: this sell is meant to leave the position empty. On Solana it
 * then also sells a rounding-sized remainder, so the token account ends up
 * empty and closeTokenAccountAfterFullExit can reclaim its rent. */
export async function executeSellFill(tokenAddress: string, tokenAmount: number, pair: MarketPair, chain: string, options: { fullExit?: boolean } = {}): Promise<FillResult> {
  const liveReady = chain === "solana" ? isSolanaLiveModeReady() : isLiveModeReady();
  if (!liveReady) {
    const fill = { ...getPaperSellQuote(tokenAmount, pair), provider: "paper" as const };
    void recordExecutionQuality({
      tokenAddress,
      chain,
      pair,
      direction: "SELL",
      success: fill.priceUsd > 0,
      slippageBps: fill.estimatedSlippageBps,
      priceImpactPercent: fill.estimatedPriceImpactPercent,
      error: fill.priceUsd > 0 ? undefined : "paper sell fill unavailable",
    });
    return fill;
  }

  if (chain === "solana") return executeSolanaSellFill(tokenAddress, tokenAmount, pair, chain, options.fullExit ?? false);

  const ethPriceUsd = ethPriceUsdFor(pair);
  if (!ethPriceUsd) throw new Error("cannot determine ETH/USD price for live sell sizing (missing priceNative)");

  const client = getPublicClient();
  const wallet = getWalletAddress();
  const token = tokenAddress as `0x${string}`;
  // ethBalanceBefore doesn't depend on decimals — read both in parallel
  // rather than serially, shaving one RPC round-trip off sell latency.
  // tokenBalanceRaw joins them because of the clamp directly below.
  const [decimals, ethBalanceBefore, tokenBalanceRaw] = await Promise.all([
    getTokenDecimals(client, token),
    client.getBalance({ address: wallet }),
    getTokenBalance(client, token, wallet),
  ]);

  // Confirmed live 2026-09-11: EVERY open position was permanently unable to
  // sell, each reverting with TRANSFER_FROM_FAILED on the pre-sign
  // simulation, retrying forever. Cause is a float round-trip, not the pool
  // or the approvals: executeBuyFill records tokenAmount as a JS Number
  // (exact wei -> double loses precision past ~17 significant digits),
  // getRemainingTokenAmount sums those doubles, and converting back here
  // rounds UP relative to what the wallet actually holds — measured live at
  // +10,514 wei (STONKBROKER), +121,198 (PERPSHOOD), +2,887,747 (QUORUM),
  // +11,113,726 (ladybug). Economically nothing; enough for transferFrom to
  // revert every single time, which is what kept the bot able to buy and
  // never able to exit. Clamping to the real balance also makes a "sell
  // 100%" actually mean the true full balance rather than a stale float's
  // idea of it, so no dust is stranded by rounding the other way.
  const requestedRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));
  const tokenAmountRaw = requestedRaw > tokenBalanceRaw ? tokenBalanceRaw : requestedRaw;
  if (tokenAmountRaw <= 0n) {
    throw new Error(`refusing to sell ${tokenAddress}: wallet holds no tokens (requested ${requestedRaw} raw units)`);
  }
  if (requestedRaw > tokenBalanceRaw) {
    logger.warn(
      { tokenAddress, requestedRaw: requestedRaw.toString(), tokenBalanceRaw: tokenBalanceRaw.toString(), excessRaw: (requestedRaw - tokenBalanceRaw).toString() },
      "sell amount exceeded the wallet's real token balance (float precision) — clamped to the actual balance"
    );
  }
  // What actually gets sold, back in human units — every downstream number
  // (proceeds, price, the SELL execution row, the remaining-position math)
  // must be based on this, not the caller's float, or the drift compounds
  // into the next sell.
  const soldTokens = Number(formatUnits(tokenAmountRaw, decimals));

  const result = await executeLiveSell(token, tokenAmountRaw, tradingConfig.defaultMaxSellSlippageBps);
  const receipt = await client.waitForTransactionReceipt({ hash: result.txHash });
  if (receipt.status !== "success") throw new Error(`live sell transaction reverted on-chain: ${result.txHash}`);

  // Any approvals this sell needed (sent inside executeLiveSell) are part of
  // its cost — pnl.ts nets gasCostUsd out of realized P&L.
  const approvalGasWei = await sumGasCostWei(client, result.approvalTxHashes).catch(() => 0n);
  const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice + approvalGasWei;
  // Confirmed 2026-09-24 (DUO): proceeds read as a before/after balance
  // delta picked up another of the wallet's transactions landing in between,
  // and a real ~$2.50 sell was recorded as $0.016. Read what the sell itself
  // paid the wallet from its trace; fall back to the balance delta only if
  // the RPC can't trace (or traces nothing, which a real sell never does).
  const tracedWei = await getEthReceivedFromTrace(client, result.txHash, wallet).catch((err) => {
    logger.warn({ tokenAddress, txHash: result.txHash, err: String(err) }, "could not trace the sell's ETH proceeds — falling back to the wallet balance delta");
    return 0n;
  });
  // Balance delta plus every wei of gas spent since the "before" read (the
  // swap's and the approvals' — both already left the balance too).
  const ethReceivedWei = tracedWei > 0n ? tracedWei : (await client.getBalance({ address: wallet })) - ethBalanceBefore + gasCostWei;
  const ethReceived = Number(formatUnits(ethReceivedWei, 18));
  const gasCostUsd = Number(formatUnits(gasCostWei, 18)) * ethPriceUsd;
  const proceedsUsd = ethReceived * ethPriceUsd;

  logger.info({ tokenAddress, txHash: result.txHash, soldTokens, proceedsUsd, gasCostUsd }, "live sell confirmed");
  void recordExecutionQuality({ tokenAddress, chain, pair, direction: "SELL", success: true, slippageBps: 0, priceImpactPercent: 0 });

  return {
    priceUsd: soldTokens > 0 ? proceedsUsd / soldTokens : 0,
    tokenAmount: soldTokens,
    estimatedSlippageBps: 0,
    estimatedPriceImpactPercent: 0,
    gasCostUsd,
    provider: "live",
    txHash: result.txHash,
    approvalTxHashes: result.approvalTxHashes,
  };
}

/** Solana branch of executeSellFill — same clamp-to-real-balance rationale as
 * the EVM path (the caller's requested amount is a JS Number that can drift
 * from the wallet's true raw balance; never let that cause a revert-forever
 * loop, clamp and sell what's actually there). */
async function executeSolanaSellFill(tokenAddress: string, tokenAmount: number, pair: MarketPair, chain: string, fullExit: boolean): Promise<FillResult> {
  // Same fallback as executeSolanaBuyFill/getBuyEstimate — critically, this
  // is the EXIT path: refusing to sell a real position just because its pair
  // isn't SOL-quoted (rather than merely refusing a new buy) would trap open
  // capital, which is strictly worse than a blocked entry.
  const solPriceUsd = deriveSolPriceUsd(pair) ?? (await getSolPriceUsd());
  if (!solPriceUsd) throw new Error("cannot determine SOL/USD price for live sell sizing (missing priceNative)");

  const conn = getSolanaConnection();
  const wallet = getSolanaWalletPublicKey();
  const mint = new PublicKey(tokenAddress);
  const [decimals, tokenBalanceRaw] = await Promise.all([getSolanaMintDecimals(conn, mint), getSolanaTokenBalance(conn, mint, wallet)]);

  const requestedRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));
  const tokenAmountRaw = sellAmountRaw(requestedRaw, tokenBalanceRaw, fullExit);
  if (tokenAmountRaw <= 0n) {
    throw new Error(`refusing to sell ${tokenAddress}: wallet holds no tokens (requested ${requestedRaw} raw units)`);
  }
  if (requestedRaw > tokenBalanceRaw) {
    logger.warn(
      { tokenAddress, requestedRaw: requestedRaw.toString(), tokenBalanceRaw: tokenBalanceRaw.toString(), excessRaw: (requestedRaw - tokenBalanceRaw).toString() },
      "sell amount exceeded the wallet's real token balance — clamped to the actual balance"
    );
  }
  if (tokenAmountRaw > requestedRaw) {
    logger.info(
      { tokenAddress, requestedRaw: requestedRaw.toString(), tokenBalanceRaw: tokenBalanceRaw.toString() },
      "full exit — also selling the rounding-sized remainder so the token account can be closed"
    );
  }
  const soldTokens = Number(tokenAmountRaw) / 10 ** decimals;

  const result = await executeSolanaLiveSell(tokenAddress, tokenAmountRaw, tradingConfig.defaultMaxSellSlippageBps);
  const proceedsUsd = (Number(result.amountOut) / LAMPORTS_PER_SOL) * solPriceUsd;
  const gasCostUsd = ((result.feeLamports ?? 0) / LAMPORTS_PER_SOL) * solPriceUsd;

  logger.info({ tokenAddress, signature: result.signature, soldTokens, proceedsUsd, gasCostUsd }, "live solana sell confirmed");
  void recordExecutionQuality({ tokenAddress, chain, pair, direction: "SELL", success: true, slippageBps: 0, priceImpactPercent: 0 });

  return {
    priceUsd: soldTokens > 0 ? proceedsUsd / soldTokens : 0,
    tokenAmount: soldTokens,
    estimatedSlippageBps: 0,
    estimatedPriceImpactPercent: 0,
    gasCostUsd,
    provider: "live",
    txHash: result.signature,
    receipt: { feeLamports: result.feeLamports },
  };
}

const ACCOUNT_CLOSE_TIMEOUT_MS = 15_000;

/**
 * After a live Solana full exit that's already recorded: closes the emptied
 * token account and returns what that changed — the close fee minus the
 * refunded rent, in USD, for the caller to book against the sell. Undefined
 * off live Solana. Never throws: a close that can't happen leaves the rent
 * as a cost of the trade, with the reason in the receipt.
 */
export async function closeTokenAccountAfterFullExit(
  tokenAddress: string,
  pair: MarketPair,
  chain: string
): Promise<{ gasCostUsd: number; receipt: SolanaFillReceipt } | undefined> {
  if (chain !== "solana" || !isSolanaLiveModeReady()) return undefined;
  const closing = closeEmptySolanaTokenAccount(tokenAddress).catch((err): TokenAccountCloseResult => ({ status: "skipped", reason: `close failed: ${String(err)}` }));
  // The position monitor checks every open trade in one sequential loop, and
  // a confirmation can take until the blockhash expires (~60-90s) — too long
  // to hold up every other position's stops. Past the ceiling the rent stays
  // booked as a cost; if the close lands later the wallet has the refund
  // anyway (P&L errs low), and the cleanup script sweeps any it missed.
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ACCOUNT_CLOSE_TIMEOUT_MS);
  });
  const outcome = await Promise.race([closing, timedOut]);
  clearTimeout(timer);
  if (outcome === "timeout") {
    void closing.then((late) =>
      logger.warn(
        { tokenAddress, ...late },
        "solana token-account close finished after the monitor moved on — any refund is in the wallet but not booked to the trade"
      )
    );
    return { gasCostUsd: 0, receipt: { closeSkippedReason: `close not finished within ${ACCOUNT_CLOSE_TIMEOUT_MS / 1000}s; left booked as a cost` } };
  }
  const close = outcome;
  if (close.status !== "closed") {
    const reason = close.status === "skipped" ? close.reason : "not closed";
    logger.warn({ tokenAddress, reason }, "solana token account left open after a full exit — its rent stays a cost of the trade");
    return { gasCostUsd: 0, receipt: { closeSkippedReason: reason } };
  }
  const receipt: SolanaFillReceipt = { closeSignature: close.signature, closeFeeLamports: close.feeLamports, rentRefundLamports: close.refundLamports };
  logger.info({ tokenAddress, signature: close.signature, refundLamports: close.refundLamports }, "closed the emptied solana token account — rent refunded");
  const solPriceUsd = deriveSolPriceUsd(pair) ?? (await getSolPriceUsd());
  if (!solPriceUsd) {
    logger.warn({ tokenAddress, signature: close.signature }, "no SOL/USD rate to value the refunded rent — left unbooked; the wallet has it");
    return { gasCostUsd: 0, receipt };
  }
  return { gasCostUsd: ((close.feeLamports - close.refundLamports) / LAMPORTS_PER_SOL) * solPriceUsd, receipt };
}

/**
 * LIVE-only reconciliation read: how many of this token the bot wallet
 * actually holds right now. Used by the position monitor to notice an
 * external/manual wallet sale instead of leaving a database position open
 * forever. Returns undefined outside LIVE mode so paper/shadow accounting
 * stays purely ledger-driven.
 */
export async function getLiveWalletTokenBalance(tokenAddress: string, chain: string): Promise<number | undefined> {
  if (chain === "solana") {
    if (!isSolanaLiveModeReady()) return undefined;
    const conn = getSolanaConnection();
    const mint = new PublicKey(tokenAddress);
    const [decimals, rawBalance] = await Promise.all([getSolanaMintDecimals(conn, mint), getSolanaTokenBalance(conn, mint, getSolanaWalletPublicKey())]);
    return Number(rawBalance) / 10 ** decimals;
  }
  if (!isLiveModeReady()) return undefined;
  const client = getPublicClient();
  const token = tokenAddress as `0x${string}`;
  const [decimals, rawBalance] = await Promise.all([
    getTokenDecimals(client, token),
    getTokenBalance(client, token, getWalletAddress()),
  ]);
  return Number(formatUnits(rawBalance, decimals));
}

/**
 * A honeypot check as much as a liquidity check: many honeypot contracts
 * happily quote a sell for a trivial dust amount while reverting on anything
 * a real position would actually hold (the classic "works in the tester,
 * fails for real buyers" pattern) — so simulate selling something close to
 * the real position size whenever the caller has one, not 1 wei. Callers
 * without a size yet (nothing built on this token so far) still get the
 * dust-amount fallback, which is still strictly better than no check.
 */
export async function isSellable(tokenAddress: string, pair: MarketPair | undefined, chain: string, realisticTokenAmount?: number): Promise<boolean> {
  const liveReady = chain === "solana" ? isSolanaLiveModeReady() : isLiveModeReady();
  if (!liveReady) return isPaperSellQuoteAvailable(pair);
  if (!pair) return false;

  if (chain === "solana") {
    let amountToSimulate = 1n;
    if (realisticTokenAmount && realisticTokenAmount > 0) {
      try {
        const decimals = await getSolanaMintDecimals(getSolanaConnection(), new PublicKey(tokenAddress));
        amountToSimulate = BigInt(Math.floor(realisticTokenAmount * 10 ** decimals));
      } catch {
        amountToSimulate = 1n;
      }
    }
    // Jupiter returning a route at all is the Solana analog of the EVM
    // check's pool-quote probe — a token with no sellable route (no venue
    // will quote it) is the aggregator equivalent of "no live pool found."
    const quote = await getSolanaLiveQuote(tokenAddress, false, amountToSimulate, tradingConfig.defaultMaxSellSlippageBps);
    return quote !== undefined;
  }

  let amountToSimulate = 1n;
  if (realisticTokenAmount && realisticTokenAmount > 0) {
    try {
      const decimals = await getTokenDecimals(getPublicClient(), tokenAddress as `0x${string}`);
      amountToSimulate = BigInt(Math.floor(realisticTokenAmount * 10 ** decimals));
    } catch {
      amountToSimulate = 1n; // decimals lookup failed — fall back to the dust check rather than skip it
    }
  }
  // Same venue the real exit would use — a token whose only pool is
  // high-fee is still sellable, just expensively, and calling it "no sell
  // path" here would feed validateEntry's honeypot rejection a false signal.
  const quote = await getLiveQuote(tokenAddress as `0x${string}`, false, amountToSimulate, { allowHighFeePools: true });
  return quote !== undefined;
}

// Any address works here — this never sends a transaction, just an eth_call
// dry-run, so it costs nothing and moves nothing real.
const TRANSFERABILITY_PROBE_RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;

/**
 * Confirmed live 2026-09-12 (SL/"Stonks Launch"): isSellable() above only
 * proves the POOL can quote a swap — pure curve math, no wallet involved.
 * SL's pool quoted fine every time; the wallet still couldn't move a single
 * wei of it, via any route, to any address — a honeypot that blocks real
 * holder transfers while leaving the quoter untouched. That can only be
 * caught by asking the token itself "can THIS wallet actually send you,"
 * which requires holding a real balance — undetectable before a buy, but
 * checkable for free (an eth_call, no gas) the instant one confirms. Callers
 * should treat a `false` here as grounds to write the position off
 * immediately rather than let positionManager retry it forever.
 */
export async function canWalletTransferToken(tokenAddress: string, tokenAmount: number, chain: string): Promise<boolean> {
  if (chain === "solana") {
    if (!isSolanaLiveModeReady() || tokenAmount <= 0) return true;
    return canSolanaWalletTransferToken(tokenAddress, tokenAmount);
  }
  if (!isLiveModeReady() || tokenAmount <= 0) return true;

  const client = getPublicClient();
  const wallet = getWalletAddress();
  const token = tokenAddress as `0x${string}`;

  // Confirmed live 2026-09-16 (RECORD/CYCLE/XBOW): re-deriving the raw probe
  // amount from the caller's float tokenAmount hits the exact float
  // round-trip bug documented on executeSellFill's real-sell path above
  // (executeBuyFill records tokenAmount as a JS Number, which can round UP
  // relative to what the wallet actually holds by the time this runs) — the
  // simulated transfer then reverts with ERC20InsufficientBalance/
  // InsufficientBalance, a real revert but not a honeypot signal, and gets
  // misread as one below. Reading the actual on-chain balance instead avoids
  // the drift entirely, same fix as executeSellFill's clamp-to-tokenBalanceRaw.
  let actualBalanceRaw: bigint;
  try {
    actualBalanceRaw = await getTokenBalance(client, token, wallet);
  } catch (err) {
    // Can't even read the balance — an infra hiccup, not evidence of a
    // honeypot. A real position already exists; don't write it off on an
    // ambiguous signal, just skip the check this cycle.
    logger.warn({ tokenAddress, err: String(err) }, "could not read on-chain balance to probe transferability — skipping the write-off check this cycle");
    return true;
  }
  if (actualBalanceRaw <= 0n) return true; // nothing to probe yet — not this check's job

  try {
    await client.simulateContract({
      address: token,
      abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "transfer",
      args: [TRANSFERABILITY_PROBE_RECIPIENT, actualBalanceRaw],
      account: wallet,
    });
    return true;
  } catch (err) {
    logger.warn({ tokenAddress, err: String(err) }, "wallet cannot transfer its actual held balance of this token — likely a honeypot that blocks real holder sales");
    return false;
  }
}
