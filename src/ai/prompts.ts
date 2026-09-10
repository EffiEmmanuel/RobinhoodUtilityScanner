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
