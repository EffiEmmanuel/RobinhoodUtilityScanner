// User-observed (anecdotal, not yet statistically confirmed against our own
// trade data — see learning.ts once there's enough closed-trade volume to
// check it for real) activity-window pattern, in the user's local time
// (UTC+1): pumps tend to concentrate ~22:00-03:00/04:00, new project
// launches cluster ~12:00-16:30. Given to the AI as soft context to weigh
// alongside actual market/technical data — never a hard rule on its own.
function timeContextLine(): string {
  const now = new Date();
  const localHour = (now.getUTCHours() + 1) % 24; // UTC+1
  return `Current time: ${now.toISOString()} (~${String(localHour).padStart(2, "0")}:00 in the user's local time, UTC+1). The user has anecdotally observed that pumps tend to concentrate roughly 22:00-03:00/04:00 local time, and strong new project launches cluster roughly 12:00-16:30 local time — this is not yet statistically confirmed against our own data, so treat it as soft context, not a rule. Don't manufacture false confidence from the clock alone; weigh it only alongside real market/technical evidence.`;
}

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

WAIT_FOR_ENTRY is not the safe default — it is a specific bet that price will revisit a lower zone,
and on fast-moving low-liquidity tokens that revisit often never comes (the move just continues
without you). If the technical state already shows a real pullback that has *since reversed* —
price sitting at or above a tested support/swing-low, EMA(9) at or crossing back above EMA(20), RSI
recovering off an oversold reading, positive 5m price change with a healthy buy ratio — that
reversal is itself the entry signal, not a reason to wait for a second, deeper dip that isn't
evidenced yet. Recommend BUY_NOW for a confirmed reclaim like this rather than defaulting to
WAIT_FOR_ENTRY; reserve WAIT_FOR_ENTRY for when price is still clearly extended above support with
no reversal signal yet. You are not sizing the position — a lower-confidence reclaim still gets
BUY_NOW with a lower risk score, which the deterministic risk engine uses to size down, rather than
being converted into a wait.

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
  return `${timeContextLine()}

TOKEN
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
