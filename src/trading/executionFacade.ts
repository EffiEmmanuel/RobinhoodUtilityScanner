import { parseEther, formatUnits } from "viem";
import { logger } from "../logger";
import { sleep } from "../util/http";
import type { MarketPair } from "../dex/types";
import { isNativeEthQuoted } from "../dex/client";
import { tradingConfig } from "./config";
import { getPaperQuote, getPaperSellQuote, isSellQuoteAvailable as isPaperSellQuoteAvailable, type PaperQuote } from "./execution";
import { isLiveModeReady, executeLiveBuy, executeLiveSell, getLiveQuote } from "./live/liveExecutionProvider";
import type { PoolKey } from "./live/poolDiscovery";
import { getPublicClient, getWalletAddress } from "./live/wallet";
import { getTokenDecimals, getTokenBalance } from "./live/tokenUtils";
import { ensureSellApprovals } from "./live/permit2Approvals";

/**
 * The one seam entryMonitor.ts and positionManager.ts call through — neither
 * of them know or care whether a fill is simulated or real. Swapping modes
 * (SHADOW <-> LIVE) never requires touching the trading-loop logic, only this
 * file and config.
 */
export interface FillResult extends PaperQuote {
  provider: "paper" | "live";
  txHash?: `0x${string}`;
  approvalTxHashes?: string[];
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
  quote: { poolKey: PoolKey; poolId: string; poolLiquidity: bigint },
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
      poolId: quote.poolId,
      fee: quote.poolKey.fee,
      tickSpacing: quote.poolKey.tickSpacing,
      hooks: quote.poolKey.hooks,
      poolLiquidity: quote.poolLiquidity.toString(),
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
export async function getBuyEstimate(tokenAddress: string, positionSizeUsd: number, pair: MarketPair): Promise<Pick<PaperQuote, "estimatedSlippageBps" | "estimatedPriceImpactPercent" | "tokenAmount">> {
  if (!isLiveModeReady()) return getPaperQuote(positionSizeUsd, pair);

  const ethPriceUsd = deriveEthPriceUsd(pair);
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
  return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent, tokenAmount: tokenOut };
}

export async function executeBuyFill(tokenAddress: string, positionSizeUsd: number, pair: MarketPair): Promise<FillResult> {
  if (!isLiveModeReady()) {
    return { ...getPaperQuote(positionSizeUsd, pair), provider: "paper" };
  }

  const ethPriceUsd = deriveEthPriceUsd(pair);
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
    executeLiveBuy(token, amountInWei, tradingConfig.defaultMaxBuySlippageBps),
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
  ensureSellApprovals(token, boughtRaw).catch((err) =>
    logger.warn({ tokenAddress, err: String(err) }, "pre-approving this position for a future sell failed — will retry at sell time instead")
  );

  return {
    priceUsd: tokenAmount > 0 ? positionSizeUsd / tokenAmount : 0,
    tokenAmount,
    estimatedSlippageBps: 0, // realized, not estimated — the real fill already happened
    estimatedPriceImpactPercent: 0,
    gasCostUsd,
    provider: "live",
    txHash: result.txHash,
    approvalTxHashes: result.approvalTxHashes,
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
export async function getSellEstimate(tokenAddress: string, tokenAmount: number, pair: MarketPair): Promise<Pick<PaperQuote, "estimatedSlippageBps" | "estimatedPriceImpactPercent" | "priceUsd">> {
  if (!isLiveModeReady()) return getPaperSellQuote(tokenAmount, pair);

  const client = getPublicClient();
  const token = tokenAddress as `0x${string}`;
  const decimals = await getTokenDecimals(client, token);
  const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));
  // Must quote the SAME venue the real sell will use (exits may route through
  // a predatory-fee pool when it's the only one) — otherwise the slippage
  // guard is judging a pool we'd never actually trade through.
  const quote = await getLiveQuote(token, false, tokenAmountRaw, { allowHighFeePools: true });
  if (!quote) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, priceUsd: 0 };

  const ethPriceUsd = deriveEthPriceUsd(pair);
  if (!ethPriceUsd) return { estimatedSlippageBps: Number.MAX_SAFE_INTEGER, estimatedPriceImpactPercent: 100, priceUsd: 0 };
  const proceedsUsd = Number(formatUnits(quote.amountOut, 18)) * ethPriceUsd;
  const effectivePriceUsd = tokenAmount > 0 ? proceedsUsd / tokenAmount : 0;
  const spotPriceUsd = pair.priceUsd ?? effectivePriceUsd;
  const priceImpactPercent = spotPriceUsd > 0 ? Math.max(0, ((spotPriceUsd - effectivePriceUsd) / spotPriceUsd) * 100) : 0;
  logSuspiciousQuote("sell", tokenAddress, quote, priceImpactPercent, spotPriceUsd, effectivePriceUsd);
  return { estimatedSlippageBps: Math.round(priceImpactPercent * 100), estimatedPriceImpactPercent: priceImpactPercent, priceUsd: effectivePriceUsd };
}

export async function executeSellFill(tokenAddress: string, tokenAmount: number, pair: MarketPair): Promise<FillResult> {
  if (!isLiveModeReady()) {
    return { ...getPaperSellQuote(tokenAmount, pair), provider: "paper" };
  }

  const ethPriceUsd = deriveEthPriceUsd(pair);
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

  const ethBalanceAfter = await client.getBalance({ address: wallet });
  const gasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
  // ETH received = balance delta plus what was spent on gas (gas already left the balance too)
  const ethReceivedWei = ethBalanceAfter - ethBalanceBefore + gasCostWei;
  const ethReceived = Number(formatUnits(ethReceivedWei, 18));
  const gasCostUsd = Number(formatUnits(gasCostWei, 18)) * ethPriceUsd;
  const proceedsUsd = ethReceived * ethPriceUsd;

  logger.info({ tokenAddress, txHash: result.txHash, soldTokens, proceedsUsd, gasCostUsd }, "live sell confirmed");

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

/**
 * A honeypot check as much as a liquidity check: many honeypot contracts
 * happily quote a sell for a trivial dust amount while reverting on anything
 * a real position would actually hold (the classic "works in the tester,
 * fails for real buyers" pattern) — so simulate selling something close to
 * the real position size whenever the caller has one, not 1 wei. Callers
 * without a size yet (nothing built on this token so far) still get the
 * dust-amount fallback, which is still strictly better than no check.
 */
export async function isSellable(tokenAddress: string, pair: MarketPair | undefined, realisticTokenAmount?: number): Promise<boolean> {
  if (!isLiveModeReady()) return isPaperSellQuoteAvailable(pair);
  if (!pair) return false;
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
