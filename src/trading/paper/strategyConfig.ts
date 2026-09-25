/**
 * PaperStrategy's JSON columns, parsed defensively: a malformed row disables
 * that strategy (with a reason) instead of throwing into the paper loop.
 */

export type PaperEntry = { type: "at-decision" };
export type PaperFilter = { venue?: "pump.fun" | "other" };
export type PaperSizing = { type: "flat"; pct: number } | { type: "brackets"; brackets: { belowUsd: number; pct: number }[]; topPct: number };

// The user's per-chain capital brackets (2026-09-25).
export const USER_BRACKETS: PaperSizing = {
  type: "brackets",
  brackets: [
    { belowUsd: 50, pct: 40 },
    { belowUsd: 100, pct: 30 },
    { belowUsd: 250, pct: 20 },
    { belowUsd: 500, pct: 15 },
    { belowUsd: 1_000, pct: 10 },
    { belowUsd: 2_500, pct: 7.5 },
  ],
  topPct: 5,
};

export function parseEntry(raw: unknown): PaperEntry | { error: string } {
  const type = (raw as { type?: unknown } | null)?.type;
  if (type === "at-decision") return { type };
  return { error: `unsupported entry ${JSON.stringify(raw)} (only "at-decision" so far)` };
}

export function parseFilter(raw: unknown): PaperFilter {
  const venue = (raw as { venue?: unknown } | null)?.venue;
  return venue === "pump.fun" || venue === "other" ? { venue } : {};
}

export function parseSizing(raw: unknown): PaperSizing | { error: string } {
  const r = raw as Record<string, unknown> | null;
  const ok = (x: unknown) => typeof x === "number" && x > 0 && x <= 100;
  if (r?.type === "flat" && ok(r.pct)) return { type: "flat", pct: r.pct as number };
  if (r?.type === "brackets" && Array.isArray(r.brackets) && ok(r.topPct)) {
    const brackets = (r.brackets as { belowUsd?: unknown; pct?: unknown }[]).filter((b) => typeof b.belowUsd === "number" && ok(b.pct));
    if (brackets.length === r.brackets.length) return { type: "brackets", brackets: brackets as { belowUsd: number; pct: number }[], topPct: r.topPct as number };
  }
  return { error: `bad sizing ${JSON.stringify(raw)}` };
}

/** Share of current equity for the next entry: always a percent of equity, never a dollar amount. */
export function sizingFraction(sizing: PaperSizing, equityUsd: number): number {
  if (sizing.type === "flat") return sizing.pct / 100;
  const bracket = [...sizing.brackets].sort((a, b) => a.belowUsd - b.belowUsd).find((b) => equityUsd < b.belowUsd);
  return (bracket?.pct ?? sizing.topPct) / 100;
}
