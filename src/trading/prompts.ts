// §84 — the AI's job is to interpret market state and propose an action; it
// never sets the final position size and never bypasses deterministic risk
// rules (src/trading/riskEngine.ts always runs after this, and can downgrade
// or reject whatever this recommends).
export const TRADE_ANALYSIS_SYSTEM = `You are the market-interpretation layer for a crypto trading system on Robinhood Chain. This
token has ALREADY passed a separate research pipeline that checked utility, contract safety, and
project credibility — you are not re-evaluating whether the project is legitimate. Your job is
narrower and purely about market structure and timing:

1. Classify the current market regime.
2. Determine whether price is meaningfully extended above recent support/swing low right now.
3. Identify a plausible support/retest zone if price is extended.
4. Recommend BUY_NOW, WAIT_FOR_ENTRY, WATCH_ONLY, or REJECT_TRADE.
5. If WAIT_FOR_ENTRY, propose a target entry market-cap zone, a "do not chase above" ceiling, and a
   technical invalidation level (a market cap below which the setup is no longer valid).

Some inputs may show LOW confidence because we have only just started watching this token — do not
invent precision the data doesn't support. A token can be a good project and still be a bad trade
right now (already extended, thin liquidity, no real trading activity yet).

Never assume high volume or a large 24h percentage gain means the move is safe to chase — a huge
gain can coexist with an imminent collapse. You are not deciding position size and you are not
approving the final trade; a separate deterministic risk engine does that regardless of what you
recommend here.

Return structured JSON only.`;

export interface TradeAnalysisInputs {
  token: { name?: string | null; symbol?: string | null };
  projectSummary: string;
  qualityScore: number;
  researchConfidence: number;
  marketText: string;
  technicalText: string;
}

export function buildTradeAnalysisPrompt(inputs: TradeAnalysisInputs): string {
  return `TOKEN
Name: ${inputs.token.name ?? "(missing)"}
Symbol: ${inputs.token.symbol ?? "(missing)"}

PROJECT RESEARCH SUMMARY (already vetted by the research pipeline)
${inputs.projectSummary}
Quality score: ${inputs.qualityScore}/100
Research confidence: ${inputs.researchConfidence}/100

CURRENT MARKET DATA
${inputs.marketText}

TECHNICAL STATE (derived from our own snapshot history — see confidence note)
${inputs.technicalText}

Analyze the current market/technical state and recommend an action now.`;
}

export const POSTMORTEM_SYSTEM = `You write postmortems for closed paper/shadow trades on a crypto trading system. Given the full
lifecycle of one trade — the original plan and reasoning, what the market actually did, how and why
it was exited — assess what worked, what failed, and what should inform future strategy versions.

Be specific and concrete, not generic. Do not soften a loss into vague positives. Your lessons are
stored for human review only — they never automatically change any production trading rule.

Return structured JSON only.`;

export interface PostmortemInputs {
  token: { name?: string | null; symbol?: string | null } | null;
  planReasoning: string[];
  entryMcap: number | undefined;
  exitMcap: number | undefined;
  realizedMultiple: number | undefined;
  mfePercent: number | undefined;
  maePercent: number | undefined;
  holdingMinutes: number | undefined;
  exitReason: string | undefined;
}

export function buildPostmortemPrompt(inputs: PostmortemInputs): string {
  return `TOKEN
Name: ${inputs.token?.name ?? "(missing)"}
Symbol: ${inputs.token?.symbol ?? "(missing)"}

ORIGINAL TRADE PLAN REASONING
${inputs.planReasoning.map((r) => `- ${r}`).join("\n") || "(none recorded)"}

OUTCOME
Entry market cap: ${inputs.entryMcap !== undefined ? `$${Math.round(inputs.entryMcap).toLocaleString()}` : "unknown"}
Exit market cap: ${inputs.exitMcap !== undefined ? `$${Math.round(inputs.exitMcap).toLocaleString()}` : "unknown"}
Realized multiple: ${inputs.realizedMultiple !== undefined ? `${inputs.realizedMultiple.toFixed(2)}x` : "unknown"}
MFE (max favorable excursion): ${inputs.mfePercent !== undefined ? `${inputs.mfePercent.toFixed(1)}%` : "unknown"}
MAE (max adverse excursion): ${inputs.maePercent !== undefined ? `${inputs.maePercent.toFixed(1)}%` : "unknown"}
Holding time: ${inputs.holdingMinutes !== undefined ? `${inputs.holdingMinutes} minutes` : "unknown"}
Exit reason: ${inputs.exitReason ?? "unknown"}

Write the postmortem now.`;
}
