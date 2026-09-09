import type { DiscoveredTokenProfile } from "../dex/types";

// FR-004: inexpensive checks that run before any AI/vision call. Intentionally
// conservative — a single meme-ish keyword must never reject on its own.
const SPAM_NAME_PATTERNS = [/^test\s?token$/i, /^unnamed$/i, /^\s*$/];

export interface CheapFilterResult {
  passed: boolean;
  reasons: string[];
}

function nameAndAddressReasons(name: string | null | undefined, address: string): string[] {
  const reasons: string[] = [];
  if (!name || SPAM_NAME_PATTERNS.some((p) => p.test(name))) {
    reasons.push("missing or placeholder token name");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    reasons.push("invalid contract address format");
  }
  return reasons;
}

// A deliberately extreme cutoff, not a tuning knob: legitimate utility tokens
// pick a supply for tokenomics reasons and essentially never land north of a
// trillion units — that number exists almost exclusively so a memecoin's
// per-token price reads as fun/cheap. Real projects with unusually large but
// deliberate supplies are the rare exception this threshold is set high
// enough to still let through.
const MEME_SUPPLY_THRESHOLD = 1_000_000_000_000;

function supplyReason(adjustedTotalSupply: number | undefined): string[] {
  if (adjustedTotalSupply === undefined || adjustedTotalSupply <= MEME_SUPPLY_THRESHOLD) return [];
  return [`total supply of ${adjustedTotalSupply.toLocaleString()} tokens is an extreme meme-coin signal (>1 trillion)`];
}

export function cheapFilter(profile: DiscoveredTokenProfile, name?: string | null, adjustedTotalSupply?: number): CheapFilterResult {
  const reasons = [...nameAndAddressReasons(name, profile.tokenAddress), ...supplyReason(adjustedTotalSupply)];
  if (!profile.icon) {
    reasons.push("missing icon");
  }
  return { passed: reasons.length === 0, reasons };
}

/**
 * Same intent as cheapFilter, for tokens sourced directly from an on-chain
 * pool-creation event rather than DexScreener — there is no icon/description
 * to check at this source (that metadata is a DexScreener-only concept), so
 * requiring one would reject every on-chain-sourced token regardless of
 * quality. The checks that ARE meaningful for this source (real name, valid
 * address, absurd token supply) stay deterministic and pre-AI, same as
 * cheapFilter's — this is what keeps obvious meme-supply tokens from ever
 * costing an AI call in the first place.
 */
export function cheapFilterOnchain(address: string, name?: string | null, adjustedTotalSupply?: number): CheapFilterResult {
  const reasons = [...nameAndAddressReasons(name, address), ...supplyReason(adjustedTotalSupply)];
  return { passed: reasons.length === 0, reasons };
}
