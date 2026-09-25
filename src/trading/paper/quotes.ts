import { getCachedSolPriceUsd } from "../portfolio";
import { getJupiterQuote, SOL_MINT } from "../live/solana/jupiterClient";
import { paperConfig } from "./config";
import { QuoteBudget } from "./quoteBudget";

/**
 * Quote-only, Solana-only, Jupiter HTTP only: no RPC, no signing, no
 * ExecutionQualityStat writes, and every request at low priority so it
 * never takes a rate-limiter slot while a live request waits.
 */

export const quoteBudget = new QuoteBudget(paperConfig.maxQuotesPerDay);
const LAMPORTS_PER_SOL = 1_000_000_000;

export type PaperQuote = { usd: number; tokensRaw: bigint } | { unavailable: "budget" | "no-sol-price" | "no-route" };

/** What `sizeUsd` of SOL buys: raw token units out. */
export async function paperBuyQuote(mint: string, sizeUsd: number): Promise<PaperQuote> {
  const solUsd = getCachedSolPriceUsd();
  if (!solUsd) return { unavailable: "no-sol-price" };
  if (!quoteBudget.tryConsume()) return { unavailable: "budget" };
  const lamports = BigInt(Math.floor((sizeUsd / solUsd) * LAMPORTS_PER_SOL));
  const q = await getJupiterQuote(SOL_MINT, mint, lamports, paperConfig.slippageBps, undefined, "low");
  if (!q || q.outAmount <= 0n) return { unavailable: "no-route" };
  return { usd: (Number(q.inAmount) / LAMPORTS_PER_SOL) * solUsd, tokensRaw: q.outAmount };
}

/** What selling `tokensRaw` returns, in USD. */
export async function paperSellQuote(mint: string, tokensRaw: bigint): Promise<PaperQuote> {
  const solUsd = getCachedSolPriceUsd();
  if (!solUsd) return { unavailable: "no-sol-price" };
  if (tokensRaw <= 0n) return { usd: 0, tokensRaw };
  if (!quoteBudget.tryConsume()) return { unavailable: "budget" };
  const q = await getJupiterQuote(mint, SOL_MINT, tokensRaw, paperConfig.slippageBps, undefined, "low");
  if (!q) return { unavailable: "no-route" };
  return { usd: (Number(q.outAmount) / LAMPORTS_PER_SOL) * solUsd, tokensRaw };
}

/**
 * Token decimals without an RPC call: the quote's USD per raw unit against
 * the pair's USD price per whole token is 10^decimals. pump.fun mints are
 * 6 decimals when the pair price is missing.
 */
export function inferDecimals(usdPerRaw: number, pairPriceUsd: number | undefined, mint: string): number | undefined {
  if (pairPriceUsd && pairPriceUsd > 0 && usdPerRaw > 0) {
    const d = Math.round(Math.log10(pairPriceUsd / usdPerRaw));
    if (d >= 0 && d <= 18) return d;
  }
  return mint.endsWith("pump") ? 6 : undefined;
}
