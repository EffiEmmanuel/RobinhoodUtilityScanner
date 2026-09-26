/**
 * Paper gate audit: which live gate blocked each candidate the paper book
 * traded, and how those trades did on real quotes. Every gate has to earn
 * its place on P&L (user directive, 2026-09-26); safety gates and the
 * autonomous-entry kill switch are reported, never proposed for removal.
 */

export interface GateBucket {
  gate: string;
  kind: "kill switch" | "safety" | "quality";
}

// Informational lines that appear on decisions that went ahead too.
const NON_BLOCKING = [/^cleared /i, /^not verified-project grade/i, /^all entry checks passed/i];

const RULES: { test: RegExp; bucket: GateBucket }[] = [
  { test: /autonomous entries are off/i, bucket: { gate: "autonomous entries off", kind: "kill switch" } },
  { test: /meme|utility class is/i, bucket: { gate: "meme / utility-class classifier", kind: "safety" } },
  { test: /honeypot|unsellable|cannot transfer|no route executes|sell quote/i, bucket: { gate: "unsellable / no executable route", kind: "safety" } },
  { test: /execution quality|suspicious quote/i, bucket: { gate: "execution-quality history", kind: "quality" } },
  { test: /liquidity is .*% of market cap|already up .* in the last hour|market cap .*(above|over|>)|mcap/i, bucket: { gate: "market / entry filter", kind: "quality" } },
  { test: /liquidityUsd .*</i, bucket: { gate: "liquidity floor", kind: "quality" } },
  { test: /utilityScore|not trade-eligible|qualityScore .*<|researchConfidence .*<|contractScore .*</i, bucket: { gate: "research / utility thresholds", kind: "quality" } },
  { test: /holder|concentration/i, bucket: { gate: "holder concentration", kind: "quality" } },
  { test: /conviction|chart|regime|chase/i, bucket: { gate: "conviction / chart / chase guard", kind: "quality" } },
];

/**
 * The gate behind a candidate's final blocking decision. A planning SKIP
 * whose reasons are all informational (plus the AI's own reasoning, nested
 * as an array) is the AI planner's REJECT_TRADE.
 */
export function classifyBlock(status: string, decision: { stage: string; decision: string; reasons: unknown } | undefined): GateBucket {
  if (status === "TRADED") return { gate: "passed: traded live", kind: "quality" };
  if (!decision) return { gate: `no decision recorded (${status})`, kind: "quality" };
  const lines = Array.isArray(decision.reasons) ? decision.reasons.filter((r): r is string => typeof r === "string") : [];
  const blocking = lines.filter((l) => !NON_BLOCKING.some((re) => re.test(l)));
  for (const line of blocking) for (const r of RULES) if (r.test.test(line)) return r.bucket;
  if (decision.stage === "planning" && decision.decision === "SKIP") return { gate: "AI planner: REJECT_TRADE", kind: "quality" };
  if (blocking.length) return { gate: `other: ${blocking[0].replace(/[0-9.]+/g, "#").slice(0, 60)}`, kind: "quality" };
  if (status === "WATCH_ONLY") return { gate: "planner: WATCH_ONLY", kind: "quality" };
  return { gate: `${decision.stage} ${decision.decision} (${status})`, kind: "quality" };
}
