import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { captureMarketSnapshot, formatMarketForPrompt } from "../research/market";
import { researchWebsite, formatWebsiteResultForPrompt, type WebsiteResearchResult } from "../research/website";
import { researchOnchain, formatOnchainResultForPrompt, type OnchainResearchResult } from "../research/onchain";
import { formatXFindingsForPrompt } from "../research/xSearch";
import { callStructured } from "../ai/provider";
import { ResearchSynthesisSchema, RESEARCH_SYNTHESIS_JSON_SCHEMA } from "../ai/schemas";
import { RESEARCH_SYNTHESIZER_SYSTEM, buildResearchSynthesisPrompt } from "../ai/prompts";
import { computeScore } from "../scoring";
import { getHolderSnapshot } from "../trading/holderConcentration";
import { getPublicClient } from "../trading/live/wallet";
import { sendAlertEmail } from "../notify/email";
import type { DiscoveredTokenProfile } from "../dex/types";
import { TokenStatus, ResearchRunStatus } from "../generated/prisma";
import { formatWalletSignalsForPrompt, getWalletSignalsForToken } from "../walletTracking/signals";

const UNAVAILABLE_WEBSITE: WebsiteResearchResult = {
  status: "UNAVAILABLE",
  githubLinks: [],
  docsLinks: [],
  socialLinks: [],
  appLinks: [],
  flags: ["website research threw and was skipped"],
};

const UNAVAILABLE_ONCHAIN: OnchainResearchResult = {
  status: "UNAVAILABLE",
  isContract: "UNKNOWN",
  ownerRenounced: "UNKNOWN",
  mintCapability: "UNKNOWN",
  pauseCapability: "UNKNOWN",
  blacklistCapability: "UNKNOWN",
  feeControlCapability: "UNKNOWN",
  verifiedSource: "UNKNOWN",
  flags: ["on-chain research threw and was skipped"],
};

function pickWebsiteUrl(profileLinks: DiscoveredTokenProfile["links"], marketWebsites: string[]): string | undefined {
  const fromProfile = profileLinks.find((l) => l.type === "website" || l.label?.toLowerCase() === "website");
  return fromProfile?.url ?? marketWebsites[0];
}

function buildLinksList(
  profile: DiscoveredTokenProfile | null,
  website: WebsiteResearchResult,
  dexUrl: string | undefined
): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  if (dexUrl) links.push({ label: "DexScreener", url: dexUrl });
  if (website.url) links.push({ label: "Website", url: website.url });
  for (const l of profile?.links ?? []) links.push({ label: l.label ?? l.type ?? "Link", url: l.url });
  for (const s of website.socialLinks) links.push({ label: "Social", url: s });
  for (const g of website.githubLinks) links.push({ label: "GitHub", url: g });
  const seen = new Set<string>();
  return links.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true))).slice(0, 12);
}

/**
 * FR-009 through FR-021: the deep research stage. Only runs after a token
 * passed the cheap visual classification gate (see classify.ts). Gathers
 * market/website/on-chain data concurrently (one source failing must not
 * fail the whole job — PRD §22), synthesizes it with one AI call, scores it
 * deterministically, and alerts/watchlists/rejects based on the score.
 */
export async function researchToken(tokenId: string): Promise<void> {
  const token = await db.token.findUniqueOrThrow({ where: { id: tokenId } });
  const startedAt = new Date();
  const run = await db.researchRun.create({ data: { tokenId, status: ResearchRunStatus.RUNNING, startedAt } });

  const classification = await db.classification.findFirst({
    where: { tokenId, passed: true },
    orderBy: { createdAt: "desc" },
  });
  if (!classification) {
    logger.error({ tokenId }, "researchToken called without a passing classification — skipping");
    await db.researchRun.update({ where: { id: run.id }, data: { status: ResearchRunStatus.FAILED, completedAt: new Date() } });
    await db.token.update({ where: { id: tokenId }, data: { status: TokenStatus.FAILED } });
    return;
  }

  const profile = (token.rawProfile as unknown as DiscoveredTokenProfile) ?? null;

  const [marketSettled, onchainSettled, holdersSettled] = await Promise.allSettled([
    captureMarketSnapshot(tokenId, token.chain, token.address),
    researchOnchain(token.address),
    getHolderSnapshot(getPublicClient(), token.address as `0x${string}`),
  ]);
  const market = marketSettled.status === "fulfilled" ? marketSettled.value : { pairs: [] };
  const onchain = onchainSettled.status === "fulfilled" ? onchainSettled.value : UNAVAILABLE_ONCHAIN;
  const holders = holdersSettled.status === "fulfilled" ? holdersSettled.value : undefined;

  const websiteUrl = pickWebsiteUrl(profile?.links ?? [], market.primaryPair?.websites ?? []);
  const website = await researchWebsite(websiteUrl).catch(() => UNAVAILABLE_WEBSITE);
  const walletSignals = await getWalletSignalsForToken(tokenId, token.address);

  const linkList = buildLinksList(profile, website, market.primaryPair?.url);
  const linksText = linkList.map((l) => `${l.label}: ${l.url}`).join("\n") || "No links found.";

  let synthesis;
  try {
    synthesis = await callStructured({
      model: config.researchModel,
      system: RESEARCH_SYNTHESIZER_SYSTEM,
      prompt: buildResearchSynthesisPrompt({
        token,
        market: formatMarketForPrompt(market),
        website: formatWebsiteResultForPrompt(website),
        onchain: formatOnchainResultForPrompt(onchain),
        links: linksText,
        xResearch: formatXFindingsForPrompt(token.xFindings),
        walletSignals: formatWalletSignalsForPrompt(walletSignals),
      }),
      schema: ResearchSynthesisSchema,
      jsonSchema: RESEARCH_SYNTHESIS_JSON_SCHEMA,
      toolName: "submit_research_synthesis",
      // Thinking tokens share this budget with the actual function-call
      // output, so this needs headroom beyond just the JSON answer's size.
      maxTokens: 6000,
    });
  } catch (err) {
    logger.error({ tokenId, err: String(err) }, "research synthesis AI call failed");
    await db.researchRun.update({ where: { id: run.id }, data: { status: ResearchRunStatus.FAILED, completedAt: new Date() } });
    await db.token.update({ where: { id: tokenId }, data: { status: TokenStatus.FAILED } });
    return;
  }

  const score = computeScore({
    classification: { brandingQuality: classification.brandingQuality, reasoningSummary: classification.reasoningSummary as string[] },
    synthesis,
    onchain,
    market,
    holders,
  });

  const completedAt = new Date();
  await db.researchRun.update({
    where: { id: run.id },
    data: {
      status: ResearchRunStatus.COMPLETED,
      completedAt,
      utilityScore: score.factors.utility.score,
      contractScore: score.factors.contract.score,
      credibilityScore: score.factors.credibility.score,
      websiteScore: score.factors.website.score,
      socialScore: score.factors.social.score,
      liquidityScore: score.factors.liquidity.score,
      marketScore: score.factors.market.score,
      holderScore: score.factors.holders.score,
      teamScore: score.factors.team.score,
      brandingScore: score.factors.branding.score,
      finalScore: score.finalScore,
      confidence: score.confidence,
      hardReject: score.hardReject,
      rejectionReasons: score.rejectionReasons,
      summary: synthesis.projectSummary,
      risks: synthesis.risks,
      positives: synthesis.positives,
      rawResearch: { market, website, onchain, holders, walletSignals, synthesis } as unknown as object,
    },
  });

  // Momentum override, same rationale as classify.ts's: the composite score
  // weighs team/social/credibility at 25% combined — signals that are
  // structurally near-zero for ANY token still in its first hours, safe or
  // not, simply because there hasn't been time to build a track record. Real,
  // already-observed two-sided trading demand is decision-grade evidence a
  // brand-new project can't fake the way it can fake a team page. Confirmed
  // live: THRU (contract clean, no hard-reject, $13-19K liquidity, hundreds
  // of real traders) scored 59 then 62 on two separate research runs — both
  // rejected on team(10-20)/social(20)/credibility(40-50) alone — then went
  // on to 2x. Never overrides hardReject; only lowers the watchlist bar.
  const primaryPair = market.primaryPair;
  const momentumHourlyTxns = (primaryPair?.buys1h ?? 0) + (primaryPair?.sells1h ?? 0);
  const momentumLiquidityUsd = primaryPair?.liquidityUsd ?? 0;
  const momentumOverride =
    !score.hardReject &&
    momentumLiquidityUsd >= config.momentumOverrideMinLiquidityUsd &&
    momentumHourlyTxns >= config.momentumOverrideMinHourlyTxns;

  let newStatus: TokenStatus;
  const meetsAlertBar = !score.hardReject && score.finalScore >= config.alertThreshold && score.confidence >= config.minConfidenceToAlert;
  const meetsWatchlistBar = !score.hardReject && (score.finalScore >= config.watchlistThreshold || momentumOverride);

  if (meetsAlertBar) {
    newStatus = TokenStatus.ALERTED;
  } else if (meetsWatchlistBar) {
    newStatus = TokenStatus.WATCHLISTED;
  } else {
    newStatus = TokenStatus.REJECTED;
  }

  if (momentumOverride && newStatus === TokenStatus.WATCHLISTED && score.finalScore < config.watchlistThreshold) {
    logger.info(
      { tokenId, address: token.address, finalScore: score.finalScore, liquidityUsd: momentumLiquidityUsd, hourlyTxns: momentumHourlyTxns },
      "research score below watchlist bar but promoted via momentum override"
    );
  }

  await db.token.update({
    where: { id: tokenId },
    data: { status: newStatus, utilityClass: synthesis.utilityClass },
  });

  logger.info(
    { tokenId, address: token.address, finalScore: score.finalScore, confidence: score.confidence, band: score.band, newStatus },
    "research complete"
  );

  if ((newStatus === TokenStatus.ALERTED || newStatus === TokenStatus.WATCHLISTED) && config.alertEmailTo) {
    const emailKind = newStatus === TokenStatus.ALERTED ? "ALERT" : "WATCHLIST";
    try {
      const providerId = await sendAlertEmail({
        kind: emailKind,
        tokenName: token.name,
        tokenSymbol: token.symbol,
        tokenAddress: token.address,
        detectedAt: token.firstSeenAt,
        researchCompletedAt: completedAt,
        score,
        synthesis,
        links: linkList,
        marketSummaryText: formatMarketForPrompt(market),
      });
      await db.alert.create({
        data: {
          tokenId,
          type: emailKind,
          score: score.finalScore,
          recipient: config.alertEmailTo,
          providerId,
        },
      });
      logger.info({ tokenId, address: token.address, type: emailKind }, "research notification email sent");
    } catch (err) {
      logger.error({ tokenId, type: emailKind, err: String(err) }, "failed to send research notification email");
    }
  }
}
