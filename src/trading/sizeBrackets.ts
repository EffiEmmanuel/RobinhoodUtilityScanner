import { logger } from "../logger";

/**
 * Capital brackets for the bot's own entries (user directive 2026-09-25):
 * the slice of a chain's equity one autonomous position may take starts high
 * while that chain's capital is small and steps down at each milestone.
 * Steps, not a taper — "capital bracket" is how the user described it.
 * Always a percent of equity, never dollars, so size keeps scaling as the
 * account grows.
 */
export interface SizeBracket {
  fromUsd: number;
  percent: number;
}

// Under $50 -> 40%, $50-100 -> 30%, $100-250 -> 20%, $250-500 -> 15%,
// $500-1k -> 10%, $1k-2.5k -> 7.5%, $2.5k and up -> 5%.
export const DEFAULT_AUTONOMOUS_SIZE_BRACKETS = "0:40,50:30,100:20,250:15,500:10,1000:7.5,2500:5";

/** "lowerBoundUsd:percent,..." — the first bound must be 0, bounds must
 * rise, and each percent must be in (0, 100]. Throws on anything else. */
export function parseSizeBrackets(raw: string): SizeBracket[] {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error("no brackets given");
  const brackets = parts.map((part) => {
    const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(part);
    if (!match) throw new Error(`"${part}" is not lowerBoundUsd:percent`);
    return { fromUsd: Number(match[1]), percent: Number(match[2]) };
  });
  if (brackets[0].fromUsd !== 0) throw new Error(`the first bracket must start at 0, not ${brackets[0].fromUsd}`);
  brackets.forEach((bracket, i) => {
    if (!(bracket.percent > 0 && bracket.percent <= 100)) throw new Error(`percent ${bracket.percent} is outside (0, 100]`);
    if (i > 0 && !(bracket.fromUsd > brackets[i - 1].fromUsd)) {
      throw new Error(`lower bounds must rise: ${brackets[i - 1].fromUsd} then ${bracket.fromUsd}`);
    }
  });
  return brackets;
}

/** Parses an env value, falling back to the default table (loudly) when it's
 * malformed — a typo must never size trades off a half-read table. */
export function loadSizeBrackets(envName: string, raw: string | undefined): SizeBracket[] {
  if (raw === undefined || raw.trim() === "") return parseSizeBrackets(DEFAULT_AUTONOMOUS_SIZE_BRACKETS);
  try {
    return parseSizeBrackets(raw);
  } catch (err) {
    logger.error(
      { env: envName, value: raw, err: String(err), default: DEFAULT_AUTONOMOUS_SIZE_BRACKETS },
      `${envName} is malformed — sizing autonomous entries with the default brackets instead`
    );
    return parseSizeBrackets(DEFAULT_AUTONOMOUS_SIZE_BRACKETS);
  }
}

export interface ResolvedSizeBracket {
  percent: number;
  // "$0–50", "$2,500+"
  label: string;
}

/** The bracket a chain's equity falls in. Negative or unreadable equity
 * falls in the first bracket; it sizes against that same equity anyway. */
export function sizeBracketFor(brackets: SizeBracket[], equityUsd: number): ResolvedSizeBracket {
  let index = 0;
  for (let i = 0; i < brackets.length; i++) if (equityUsd >= brackets[i].fromUsd) index = i;
  const bracket = brackets[index];
  const next = brackets[index + 1];
  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
  return { percent: bracket.percent, label: next ? `${usd(bracket.fromUsd)}–${next.fromUsd.toLocaleString("en-US")}` : `${usd(bracket.fromUsd)}+` };
}
