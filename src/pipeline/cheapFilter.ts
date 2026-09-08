import type { DiscoveredTokenProfile } from "../dex/types";

// FR-004: inexpensive checks that run before any AI/vision call. Intentionally
// conservative — a single meme-ish keyword must never reject on its own.
const SPAM_NAME_PATTERNS = [/^test\s?token$/i, /^unnamed$/i, /^\s*$/];

export interface CheapFilterResult {
  passed: boolean;
  reasons: string[];
}

export function cheapFilter(profile: DiscoveredTokenProfile, name?: string | null): CheapFilterResult {
  const reasons: string[] = [];

  if (!name || SPAM_NAME_PATTERNS.some((p) => p.test(name))) {
    reasons.push("missing or placeholder token name");
  }
  if (!profile.icon) {
    reasons.push("missing icon");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(profile.tokenAddress)) {
    reasons.push("invalid contract address format");
  }

  return { passed: reasons.length === 0, reasons };
}
