import { config } from "../../../config";
import { logger } from "../../../logger";
import { fetchJsonWithRetry } from "../../../util/http";

// api.jup.ag (the paid tier) requires this on every call; lite-api.jup.ag
// (the free tier) ignores it, so it's always safe to send when configured
// regardless of which base URL is active. Never logged or included in any
// object that gets serialized elsewhere.
function jupiterHeaders(extra?: Record<string, string>): Record<string, string> {
  return config.jupiterApiKey ? { ...extra, "x-api-key": config.jupiterApiKey } : { ...extra };
}

// Wrapped native SOL's mint address — the input/output mint for any
// SOL-denominated leg of a swap, the direct analog of NATIVE_ETH_CURRENCY on
// the EVM side.
export const SOL_MINT = "So11111111111111111111111111111111111111112";

interface RawJupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  slippageBps: number;
  [key: string]: unknown; // routePlan and other fields we don't read but must round-trip to /swap unchanged
}

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPercent: number;
  // The full, unmodified quote response — /swap requires this back verbatim
  // as quoteResponse, not a re-derived subset.
  raw: RawJupiterQuoteResponse;
}

/**
 * Real Jupiter-aggregated quote — this hits Jupiter's own API (which itself
 * simulates against live pool state), not an on-chain eth_call-style dry run
 * the way the EVM check's getLiveQuote is. No manual pool discovery needed:
 * Jupiter routes across Raydium/Orca/pump.fun/etc. itself.
 */
export async function getJupiterQuote(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<JupiterQuote | undefined> {
  const url = `${config.solanaJupiterBaseUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount.toString()}&slippageBps=${slippageBps}`;
  try {
    const raw = await fetchJsonWithRetry<RawJupiterQuoteResponse>(url, { headers: jupiterHeaders() });
    return {
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      inAmount: BigInt(raw.inAmount),
      outAmount: BigInt(raw.outAmount),
      priceImpactPercent: Number(raw.priceImpactPct) * 100,
      raw,
    };
  } catch (err) {
    logger.warn({ inputMint, outputMint, err: String(err) }, "jupiter quote failed");
    return undefined;
  }
}

/**
 * Builds the actual (unsigned) swap transaction for a previously-fetched
 * quote — base64-encoded, to be deserialized into a VersionedTransaction,
 * vetted, and signed by wallet.ts. Jupiter's swap-transaction builder already
 * includes any missing-ATA creation instructions itself, so no separate
 * pre-create-ATA step is needed on the buy side.
 */
export async function getJupiterSwapTransaction(quote: JupiterQuote, userPublicKey: string): Promise<string | undefined> {
  try {
    return await fetchJsonWithRetry<{ swapTransaction: string }>(`${config.solanaJupiterBaseUrl}/swap`, {
      method: "POST",
      headers: jupiterHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        // "auto" lets Jupiter set a priority fee from recent network
        // conditions, capped at 0.005 SOL (confirmed via Jupiter's docs,
        // 2026-09-16) — a reasonable first cut per the project plan's
        // priority-fee open decision. `priorityLevelWithMaxLamports` (an
        // object: { priorityLevel: "medium"|"high"|"veryHigh", maxLamports })
        // is Jupiter's recommended alternative for finer control if landing
        // rate turns out to matter more than this default handles.
        prioritizationFeeLamports: "auto",
      }),
    }).then((res) => res.swapTransaction);
  } catch (err) {
    logger.warn({ err: String(err) }, "jupiter swap-transaction build failed");
    return undefined;
  }
}
