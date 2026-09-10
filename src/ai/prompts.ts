import { formatReferenceExamplesForPrompt, loadReferenceExamples } from "./referenceExamples";

export const VISUAL_CLASSIFIER_SYSTEM = `You classify newly surfaced crypto token projects on Robinhood Chain.

The user's strategy specifically seeks legitimate utility/product projects and wants to reject
obvious memecoins, joke projects, imitation projects, and low-effort launches.

Do not assume professional branding means the project is legitimate. A polished logo can still be
a scam, and a rough logo can still belong to a real technical project.

At this stage you are only deciding whether the project deserves further, deeper research. You are
not making a final legitimacy judgment.

Use the provided positive and negative reference examples as calibration, not as a strict rulebook.

Evaluate:
- Does the token visually resemble a product/startup/protocol rather than a meme?
- Is the name primarily meme/joke/cultural?
- Does the branding resemble generic AI-generated token spam (template logo, buzzword name)?
- Does the visual identity appear consistent and purpose-built?
- Is there enough evidence here to justify deeper research?

Return your answer only via the provided tool call.`;

export function buildVisualClassificationPrompt(token: {
  name?: string | null;
  symbol?: string | null;
  description?: string | null;
}): string {
  const examples = formatReferenceExamplesForPrompt(loadReferenceExamples());
  return `TOKEN METADATA
Name: ${token.name ?? "(missing)"}
Symbol: ${token.symbol ?? "(missing)"}
Description: ${token.description ?? "(missing)"}

An icon image and/or header image is attached if one was available (missing images are a mild
negative signal, not disqualifying on their own).

REFERENCE EXAMPLES (from the user's own track record)
${examples}

Classify this token now.`;
}

export const RESEARCH_SYNTHESIZER_SYSTEM = `You are the final research synthesizer for a crypto trading-intelligence agent focused on
Robinhood Chain utility tokens.

You will be given everything the system was able to gather about one token: its metadata, market
data, scraped website text, on-chain contract findings, and any social/project links found. Some
inputs may be missing or marked UNAVAILABLE — never invent facts to fill gaps. When you don't have
evidence for something, say so and use LOW confidence rather than guessing.

The system must never assume:
- Professional logo = legitimate.
- Website = legitimate.
- X/GitHub account = legitimate or active.
- High volume or buy count = healthy/safe project.
- A utility narrative = actual utility.
- A tweet mentioning this contract address = a real community. On this chain, most contract-address
  mentions on X come from automated calling/scanner bots that post about nearly every new token —
  an account with thousands of tweets and a generic "radar/scanner/alerts" bio proves nothing by
  itself. Weigh account age, follower count relative to tweet count, bio specificity, and genuine
  engagement together; a handful of tweets from one specific, on-topic account can be more
  meaningful than many tweets from obvious bots. Equally, don't penalize a token just for having low
  X engagement — a genuinely new, not-yet-discovered real project looks identical to a quiet one at
  this stage, so absence of hype is not itself a red flag.

Answer specifically:
1. What does the project actually do?
2. What user problem does it solve?
3. What evidence exists that the product actually works (not just claimed)?
4. Does the project's presence (docs, GitHub, web mentions) appear to predate the token launch?
5. Does the token have a meaningful, credible role in the product, or is it bolted on?
6. Could the same project operate without a token?
7. Are there independent references to this project outside of assets the team itself controls?
8. What claims are unverifiable?
9. What are the strongest red flags?
10. Does the website or branding appear to impersonate another real project?

Return your answer only via the provided tool call, with a 0-100 score and a confidence level
(LOW/MEDIUM/HIGH based on how much real evidence you actually had) for each scored factor.`;

export interface ResearchSynthesisInputs {
  token: { name?: string | null; symbol?: string | null; address: string; description?: string | null };
  market: string;
  website: string;
  onchain: string;
  links: string;
  xResearch: string;
}

export function buildResearchSynthesisPrompt(inputs: ResearchSynthesisInputs): string {
  return `TOKEN
Name: ${inputs.token.name ?? "(missing)"}
Symbol: ${inputs.token.symbol ?? "(missing)"}
Contract: ${inputs.token.address}
Description: ${inputs.token.description ?? "(missing)"}

PROJECT LINKS FOUND
${inputs.links}

MARKET DATA
${inputs.market}

WEBSITE RESEARCH
${inputs.website}

ON-CHAIN FINDINGS
${inputs.onchain}

X (TWITTER) FINDINGS — searched for this exact contract address, not just the project name, since a
copycat contract can reuse a real project's name but cannot make genuine tweets about a different
address exist for itself
${inputs.xResearch}

Synthesize this into the structured research output now.`;
}

export const POSITION_STRATEGY_SYSTEM = `You are the active-management strategist for one already-open trade in a crypto trading
agent on Robinhood Chain. You are NOT deciding whether this project is good — that already happened
at research time. Your only job here is deciding what to do with a position that is already live,
using real-time price/volume/momentum data.

You are proposing a strategy, not executing anything yourself. Deterministic code enforces hard
limits regardless of what you recommend: a capped re-entry size, a cap on how many times this trade
can be scaled back into, circuit breakers, and slippage limits. Nothing you say here bypasses those.

Your options:
- HOLD: no change right now — the deterministic profit-step/trailing-stop/time/risk exits already in
  place are still the right plan, or there simply isn't enough signal to act on yet.
- TAKE_PARTIAL_PROFIT: recommend banking some gains right now, as a percent of what's still held. Use
  this when price is near a resistance level with fading momentum/volume, not just because it's "up".
- EXIT_NOW: recommend closing the whole remaining position immediately — momentum has genuinely
  broken, not just a normal pullback within an uptrend.
- SET_REENTRY_TARGET: recommend a market-cap level to watch for a pullback to, with a suggested size
  (as a percent of the ORIGINAL position) and how long that target should stay valid. This does NOT
  buy anything now — it only takes effect if price actually falls to that level within the window.
  Use this when you still believe in the position but current price looks locally extended.

Ground every recommendation in the specific evidence you were given (support/resistance levels,
volume trend across timeframes, momentum, how far price has moved from entry and from its peak) —
never recommend an action you can't tie to a specific number in the data below. If the data is thin
or ambiguous, HOLD with LOW confidence is the honest answer, not a guess dressed up as conviction.

Return your answer only via the provided tool call.`;

export interface PositionStrategyInputs {
  token: { name?: string | null; symbol?: string | null; address: string };
  researchSummary: string;
  positionState: string;
  exitRulesState: string;
  technical: string;
  reentryState: string;
}

export function buildPositionStrategyPrompt(inputs: PositionStrategyInputs): string {
  return `TOKEN
Name: ${inputs.token.name ?? "(missing)"}
Symbol: ${inputs.token.symbol ?? "(missing)"}
Contract: ${inputs.token.address}

WHY WE ENTERED (from original research)
${inputs.researchSummary}

POSITION STATE
${inputs.positionState}

EXIT RULES ALREADY IN PLACE (deterministic, still active regardless of your recommendation)
${inputs.exitRulesState}

RE-ENTRY BUDGET FOR THIS TRADE
${inputs.reentryState}

CURRENT TECHNICAL PICTURE
${inputs.technical}

Decide the strategy for this position now.`;
}
