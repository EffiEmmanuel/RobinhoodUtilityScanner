import { Prisma, ResearchRunStatus, TokenStatus, TradeCandidateStatus, TradeDecision } from "../generated/prisma";
import { config } from "../config";
import { db } from "../db";
import { fetchTrendingMetas, searchPairs } from "../dex/client";
import type { MarketPair, TrendingMeta } from "../dex/types";
import { logger } from "../logger";
import { searchXForNarrative, type XNarrativeSearchResult } from "../research/xSearch";
import { evaluateHoneypotRisk } from "./honeypotCheck";
import { evaluateCandidate } from "./riskEngine";
import { getActiveStrategyVersion } from "./strategy";
import { tradingConfig } from "./config";

const NARRATIVE_REEVALUATION_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface NarrativeScoreInput {
  meta: TrendingMeta;
  metaRank: number;
  pair: MarketPair;
  xFindings?: XNarrativeSearchResult;
}

export interface NarrativeScoreResult {
  score: number;
  dexScore: number;
  marketScore: number;
  xScore: number;
  passed: boolean;
  reasons: string[];
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function logScore(value: number | undefined, floor: number, ceiling: number): number {
  const v = Math.max(value ?? 0, 0);
  if (v <= floor) return 0;
  return clamp(((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor))) * 100);
}

function buyRatio(pair: MarketPair): number | undefined {
  const buys = pair.buys1h ?? 0;
  const sells = pair.sells1h ?? 0;
  const total = buys + sells;
  return total > 0 ? buys / total : undefined;
}

function hourlyTxns(pair: MarketPair): number {
  return (pair.buys1h ?? 0) + (pair.sells1h ?? 0);
}

function tokenAddress(pair: MarketPair): string | undefined {
  return pair.baseTokenAddress?.toLowerCase();
}

function matchesMetaToken(meta: TrendingMeta, pair: MarketPair): boolean {
  const haystack = `${pair.baseTokenName ?? ""} ${pair.baseTokenSymbol ?? ""}`.toLowerCase();
  const name = meta.name.toLowerCase();
  const slug = meta.slug.toLowerCase();
  return haystack.includes(name) || haystack.includes(slug);
}

function cashtagCandidate(meta: TrendingMeta): string | undefined {
  const cleaned = meta.slug.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return cleaned.length >= 2 && cleaned.length <= 10 ? `$${cleaned}` : undefined;
}

function buildXQuery(meta: TrendingMeta): string {
  const terms = [`"${meta.name}"`];
  if (meta.slug.toLowerCase() !== meta.name.toLowerCase()) terms.push(`"${meta.slug}"`);
  const cashtag = cashtagCandidate(meta);
  if (cashtag) terms.push(cashtag);
  return `(${terms.join(" OR ")}) -is:retweet lang:en`;
}

export function scoreNarrativeCandidate(input: NarrativeScoreInput): NarrativeScoreResult {
  const { meta, metaRank, pair, xFindings } = input;
  const reasons: string[] = [];
  const ratio = buyRatio(pair);
  const txns = hourlyTxns(pair);
  const liquidityUsd = pair.liquidityUsd ?? 0;
  const volume1h = pair.volume1h ?? 0;
  const volumeToLiquidity1h = liquidityUsd > 0 ? volume1h / liquidityUsd : Number.POSITIVE_INFINITY;

  const metaMomentum =
    Math.max(meta.marketCapChange?.h1 ?? -25, -25) * 1.4 +
    Math.max(meta.marketCapChange?.h6 ?? -25, -25) * 0.8 +
    Math.max(meta.marketCapChange?.h24 ?? -25, -25) * 0.35;
  const dexScore = clamp(
    18 +
      (metaRank <= 3 ? 16 : metaRank <= 8 ? 10 : 4) +
      logScore(meta.volume, tradingConfig.narrativeMinMetaVolumeUsd, 250_000_000) * 0.25 +
      logScore(meta.liquidity, tradingConfig.narrativeMinMetaLiquidityUsd, 100_000_000) * 0.15 +
      logScore(meta.tokenCount, tradingConfig.narrativeMinTokenCount, 150) * 0.12 +
      clamp(metaMomentum + 25, 0, 50) * 0.25
  );

  const ratioScore =
    ratio === undefined
      ? 20
      : ratio >= tradingConfig.narrativeMinBuyRatio1h && ratio <= tradingConfig.narrativeMaxBuyRatio1h
        ? 100 - Math.abs(ratio - 0.66) * 120
        : 10;
  const marketScore = clamp(
    logScore(liquidityUsd, tradingConfig.narrativeMinLiquidityUsd, 250_000) * 0.3 +
      logScore(txns, tradingConfig.narrativeMinHourlyTxns, 800) * 0.25 +
      logScore(volume1h, 1_000, 500_000) * 0.2 +
      ratioScore * 0.2 +
      clamp((pair.priceChange1h ?? 0) + 20, 0, 60) * 0.05
  );

  const xScore = xFindings?.error
    ? 35
    : clamp(
        logScore(xFindings?.tweetCount, 3, 150) * 0.3 +
          logScore(xFindings?.uniqueAccountCount, 2, 60) * 0.25 +
          logScore(xFindings?.totalEngagement, 5, 5_000) * 0.25 +
          logScore(xFindings?.credibleAccountCount, 1, 20) * 0.2
      );

  if ((meta.volume ?? 0) < tradingConfig.narrativeMinMetaVolumeUsd) {
    reasons.push(`meta volume $${Math.round(meta.volume ?? 0).toLocaleString()} < $${tradingConfig.narrativeMinMetaVolumeUsd.toLocaleString()}`);
  }
  if ((meta.liquidity ?? 0) < tradingConfig.narrativeMinMetaLiquidityUsd) {
    reasons.push(`meta liquidity $${Math.round(meta.liquidity ?? 0).toLocaleString()} < $${tradingConfig.narrativeMinMetaLiquidityUsd.toLocaleString()}`);
  }
  if ((meta.tokenCount ?? 0) < tradingConfig.narrativeMinTokenCount) {
    reasons.push(`meta tokenCount ${meta.tokenCount ?? 0} < ${tradingConfig.narrativeMinTokenCount}`);
  }
  if (liquidityUsd < tradingConfig.narrativeMinLiquidityUsd) {
    reasons.push(`token liquidity $${Math.round(liquidityUsd).toLocaleString()} < $${tradingConfig.narrativeMinLiquidityUsd.toLocaleString()}`);
  }
  if (txns < tradingConfig.narrativeMinHourlyTxns) {
    reasons.push(`token hourly txns ${txns} < ${tradingConfig.narrativeMinHourlyTxns}`);
  }
  if (ratio === undefined) {
    reasons.push("token has no 1h buy/sell ratio yet");
  } else if (ratio < tradingConfig.narrativeMinBuyRatio1h || ratio > tradingConfig.narrativeMaxBuyRatio1h) {
    reasons.push(`token buy ratio ${(ratio * 100).toFixed(0)}% outside ${Math.round(tradingConfig.narrativeMinBuyRatio1h * 100)}-${Math.round(tradingConfig.narrativeMaxBuyRatio1h * 100)}%`);
  }
  if (volumeToLiquidity1h > tradingConfig.narrativeMaxVolumeToLiquidity1h) {
    reasons.push(`token 1h volume/liquidity ${volumeToLiquidity1h.toFixed(1)}x > ${tradingConfig.narrativeMaxVolumeToLiquidity1h}x`);
  }

  const score = Math.round((dexScore * 0.38 + marketScore * 0.42 + xScore * 0.2) * 10) / 10;
  if (score < tradingConfig.narrativeMinScore) {
    reasons.push(`narrative score ${score} < ${tradingConfig.narrativeMinScore}`);
  }

  return {
    score,
    dexScore: Math.round(dexScore * 10) / 10,
    marketScore: Math.round(marketScore * 10) / 10,
    xScore: Math.round(xScore * 10) / 10,
    passed: reasons.length === 0,
    reasons: reasons.length ? reasons : [`cleared narrative/meta gate with score ${score}`],
  };
}

async function findRecentNarrativeCandidate(tokenId: string, metaSlug: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - NARRATIVE_REEVALUATION_WINDOW_MS);
  const recent = await db.narrativeSnapshot.findFirst({
    where: {
      tokenId,
      metaSlug,
      createdAt: { gte: cutoff },
      tradeCandidates: { some: {} },
    },
    select: { id: true },
  });
  return recent !== null;
}

async function upsertNarrativeToken(pair: MarketPair) {
  const address = tokenAddress(pair);
  if (!address) return undefined;
  return db.token.upsert({
    where: { chain_address: { chain: pair.chainId ?? config.targetChainId, address } },
    create: {
      chain: pair.chainId ?? config.targetChainId,
      address,
      name: pair.baseTokenName,
      symbol: pair.baseTokenSymbol,
      iconUrl: pair.imageUrl,
      headerUrl: pair.headerUrl,
      status: TokenStatus.WATCHLISTED,
      utilityClass: "MEME",
      rawProfile: {
        source: "narrative-dex-search",
        url: pair.url,
        websites: pair.websites,
        socials: pair.socials,
      } as unknown as object,
    },
    update: {
      lastSeenAt: new Date(),
      name: pair.baseTokenName,
      symbol: pair.baseTokenSymbol,
      iconUrl: pair.imageUrl,
      headerUrl: pair.headerUrl,
    },
  });
}

async function createNarrativeCandidate(input: {
  meta: TrendingMeta;
  metaRank: number;
  pair: MarketPair;
  xFindings?: XNarrativeSearchResult;
  score: NarrativeScoreResult;
}): Promise<boolean> {
  const token = await upsertNarrativeToken(input.pair);
  if (!token) return false;
  if (await findRecentNarrativeCandidate(token.id, input.meta.slug)) return false;

  const honeypot = await evaluateHoneypotRisk(token.address);
  const hardReject = !honeypot.passed;
  const contractScore = honeypot.passed ? 85 : 0;
  const liquidityUsd = input.pair.liquidityUsd ?? 0;
  const txns = hourlyTxns(input.pair);

  const run = await db.researchRun.create({
    data: {
      tokenId: token.id,
      status: ResearchRunStatus.COMPLETED,
      startedAt: new Date(),
      completedAt: new Date(),
      utilityScore: 20,
      contractScore,
      credibilityScore: input.score.xScore,
      websiteScore: input.pair.websites.length > 0 ? 45 : 10,
      socialScore: input.score.xScore,
      liquidityScore: input.score.marketScore,
      marketScore: input.score.marketScore,
      brandingScore: 50,
      finalScore: input.score.score,
      confidence: clamp(input.score.score * 0.9),
      hardReject,
      rejectionReasons: hardReject ? (honeypot.reasons as unknown as object) : Prisma.JsonNull,
      summary: `Narrative tactical candidate for ${input.meta.name}: ${input.score.reasons.join("; ")}`,
      risks: [
        "narrative/memecoin lane decays quickly",
        "project fundamentals are not verified",
        ...honeypot.reasons,
      ] as unknown as object,
      positives: input.score.reasons as unknown as object,
      rawResearch: {
        source: "narrative-trading",
        synthesis: {
          utilityClass: "MEME",
          productExists: false,
          productPredatesToken: "NO",
        },
        narrative: {
          meta: input.meta,
          metaRank: input.metaRank,
          score: input.score,
          xFindings: input.xFindings,
        },
        market: { primaryPair: input.pair },
        honeypot,
      } as unknown as object,
    },
  });

  const snapshot = await db.narrativeSnapshot.create({
    data: {
      tokenId: token.id,
      metaName: input.meta.name,
      metaSlug: input.meta.slug,
      metaRank: input.metaRank,
      narrativeScore: input.score.score,
      xScore: input.score.xScore,
      dexScore: input.score.dexScore,
      marketScore: input.score.marketScore,
      xTweetCount: input.xFindings?.tweetCount,
      xUniqueAccounts: input.xFindings?.uniqueAccountCount,
      xTotalEngagement: input.xFindings?.totalEngagement,
      marketCapUsd: input.pair.marketCapUsd,
      liquidityUsd,
      volume1h: input.pair.volume1h,
      volume24h: input.pair.volume24h,
      buyRatio1h: buyRatio(input.pair),
      reasons: input.score.reasons as unknown as object,
      dexMeta: input.meta as unknown as object,
      tokenMarket: input.pair as unknown as object,
      xFindings: input.xFindings ? (input.xFindings as unknown as object) : Prisma.JsonNull,
    },
  });

  const evaluation = evaluateCandidate({
    qualityScore: input.score.score,
    researchConfidence: clamp(input.score.score * 0.9),
    contractScore,
    liquidityUsd,
    hourlyTxns: txns,
    hardReject,
  });
  const strategy = await getActiveStrategyVersion();
  const candidate = await db.tradeCandidate.create({
    data: {
      tokenId: token.id,
      researchRunId: run.id,
      narrativeSnapshotId: snapshot.id,
      qualityScore: input.score.score,
      researchConfidence: clamp(input.score.score * 0.9),
      marketRiskScore: 100 - input.score.marketScore,
      status: evaluation.eligible ? TradeCandidateStatus.QUALIFIED : TradeCandidateStatus.REJECTED,
      qualificationPath: "NARRATIVE_META",
      tradeLane: "NARRATIVE_TACTICAL",
    },
  });

  await db.tradeDecisionSnapshot.create({
    data: {
      candidateId: candidate.id,
      decision: evaluation.eligible ? TradeDecision.WAIT : TradeDecision.SKIP,
      stage: "narrative_candidate_eligibility",
      strategyVersionId: strategy.id,
      marketState: {
        meta: input.meta,
        pair: input.pair,
      },
      projectState: {
        narrativeScore: input.score.score,
        contractScore,
        xFindings: input.xFindings,
      },
      technicalState: {},
      portfolioState: {},
      deterministicRules: {
        evaluation,
        narrativeScore: input.score,
        honeypot,
        qualificationPath: "NARRATIVE_META",
        tradeLane: "NARRATIVE_TACTICAL",
      },
      finalReasons: [...input.score.reasons, ...evaluation.reasons],
    },
  });

  logger.info(
    {
      tokenId: token.id,
      candidateId: candidate.id,
      meta: input.meta.slug,
      score: input.score.score,
      eligible: evaluation.eligible,
      reasons: evaluation.reasons,
    },
    "narrative trade candidate created"
  );
  return true;
}

export async function generateNarrativeTradeCandidates(): Promise<number> {
  if (!tradingConfig.narrativeTradingEnabled) return 0;

  const metas = (await fetchTrendingMetas()).slice(0, tradingConfig.narrativeMaxMetasPerPoll);
  let created = 0;
  let xSearches = 0;

  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    let xFindings: XNarrativeSearchResult | undefined;
    if (config.xBearerToken && xSearches < tradingConfig.narrativeMaxXSearchesPerPoll) {
      xFindings = await searchXForNarrative(buildXQuery(meta)).catch((err) => ({
        query: buildXQuery(meta),
        tweetCount: 0,
        uniqueAccountCount: 0,
        totalEngagement: 0,
        credibleAccountCount: 0,
        sampleTweetUrls: [],
        accounts: [],
        error: String(err),
      }));
      xSearches++;
    }

    let pairs: MarketPair[];
    try {
      pairs = await searchPairs(meta.name);
    } catch (err) {
      logger.warn({ meta: meta.slug, err: String(err) }, "narrative pair search failed");
      continue;
    }

    const targetPairs = pairs
      .filter((p) => (p.chainId ?? "").toLowerCase() === config.targetChainId.toLowerCase())
      .filter((p) => tokenAddress(p))
      .filter((p) => matchesMetaToken(meta, p))
      .sort((a, b) => (b.volume1h ?? 0) - (a.volume1h ?? 0) || (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
      .slice(0, tradingConfig.narrativeMaxPairsPerMeta);

    for (const pair of targetPairs) {
      const score = scoreNarrativeCandidate({ meta, metaRank: i + 1, pair, xFindings });
      if (!score.passed) continue;
      if (await createNarrativeCandidate({ meta, metaRank: i + 1, pair, xFindings, score })) created++;
    }
  }

  if (created > 0) logger.info({ created, metas: metas.length, xSearches }, "narrative candidates generated");
  return created;
}
