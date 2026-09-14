import { db } from "../db";
import { logger } from "../logger";
import { TradeCandidateStatus } from "../generated/prisma";
import { pollCandidateMarket } from "./marketAnalysis";
import { getSellEstimate } from "./executionFacade";
import { tradingConfig } from "./config";
import type { MarketPair } from "../dex/types";

const OBSERVATION_WINDOW_HOURS = 48;
const HIT_MULTIPLES = {
  hit125x: 1.25,
  hit150x: 1.5,
  hit200x: 2,
  hit250x: 2.5,
  hit500x: 5,
  hit1000x: 10,
  hit2500x: 25,
  hit5000x: 50,
  hit10000x: 100,
} as const;
type HitField = keyof typeof HIT_MULTIPLES;

interface FeasiblePeakResult {
  feasible: boolean;
  multiple: number;
  reasons: string[];
}

function hitFlags(existing: { [K in HitField]?: boolean | null } | undefined, bestMultiple: number): Record<HitField, boolean> {
  return {
    hit125x: Boolean(existing?.hit125x) || bestMultiple >= HIT_MULTIPLES.hit125x,
    hit150x: Boolean(existing?.hit150x) || bestMultiple >= HIT_MULTIPLES.hit150x,
    hit200x: Boolean(existing?.hit200x) || bestMultiple >= HIT_MULTIPLES.hit200x,
    hit250x: Boolean(existing?.hit250x) || bestMultiple >= HIT_MULTIPLES.hit250x,
    hit500x: Boolean(existing?.hit500x) || bestMultiple >= HIT_MULTIPLES.hit500x,
    hit1000x: Boolean(existing?.hit1000x) || bestMultiple >= HIT_MULTIPLES.hit1000x,
    hit2500x: Boolean(existing?.hit2500x) || bestMultiple >= HIT_MULTIPLES.hit2500x,
    hit5000x: Boolean(existing?.hit5000x) || bestMultiple >= HIT_MULTIPLES.hit5000x,
    hit10000x: Boolean(existing?.hit10000x) || bestMultiple >= HIT_MULTIPLES.hit10000x,
  };
}

async function evaluateFeasiblePeak(input: {
  tokenAddress: string;
  pair: MarketPair | undefined;
  marketCapAtDetection: number;
  currentMarketCap: number;
  existingFeasibleMultiple: number;
}): Promise<FeasiblePeakResult> {
  const multiple = input.marketCapAtDetection > 0 ? input.currentMarketCap / input.marketCapAtDetection : 0;
  const reasons: string[] = [];
  const pair = input.pair;
  if (!pair) return { feasible: false, multiple: input.existingFeasibleMultiple, reasons: ["no primary pair"] };
  if (multiple <= input.existingFeasibleMultiple) {
    return { feasible: true, multiple: input.existingFeasibleMultiple, reasons: ["existing feasible peak already higher"] };
  }

  const liquidityUsd = pair.liquidityUsd ?? 0;
  if (liquidityUsd < tradingConfig.outcomeFeasibleMinLiquidityUsd) {
    reasons.push(`liquidity $${Math.round(liquidityUsd).toLocaleString()} < $${tradingConfig.outcomeFeasibleMinLiquidityUsd.toLocaleString()}`);
  }
  const liquidityToMcap = input.currentMarketCap > 0 ? liquidityUsd / input.currentMarketCap : 0;
  if (liquidityToMcap < tradingConfig.outcomeFeasibleMinLiquidityToMcapRatio) {
    reasons.push(`liquidity/mcap ${(liquidityToMcap * 100).toFixed(1)}% < ${(tradingConfig.outcomeFeasibleMinLiquidityToMcapRatio * 100).toFixed(1)}%`);
  }

  if (reasons.length === 0 && tradingConfig.outcomeFeasibleSellQuoteEnabled) {
    const priceUsd = pair.priceUsd ?? 0;
    if (priceUsd <= 0) {
      reasons.push("no usable token price for sell probe");
    } else {
      const probeUsd = Math.min(tradingConfig.outcomeFeasibleProbeUsd, liquidityUsd * 0.005);
      const probeTokens = probeUsd / priceUsd;
      try {
        const quote = await getSellEstimate(input.tokenAddress, probeTokens, pair);
        if (quote.priceUsd <= 0) reasons.push("sell probe returned no proceeds");
        if (quote.estimatedPriceImpactPercent > tradingConfig.outcomeFeasibleMaxSellImpactPercent) {
          reasons.push(`sell impact ${quote.estimatedPriceImpactPercent.toFixed(1)}% > ${tradingConfig.outcomeFeasibleMaxSellImpactPercent}%`);
        }
      } catch (err) {
        reasons.push(`sell probe failed: ${String(err).slice(0, 120)}`);
      }
    }
  }

  return {
    feasible: reasons.length === 0,
    multiple: reasons.length === 0 ? multiple : input.existingFeasibleMultiple,
    reasons: reasons.length === 0 ? ["tradable peak: liquidity/depth/sell probe passed"] : reasons,
  };
}

/**
 * §61/§62 — tracks EVERY candidate's actual subsequent market performance for
 * the full 48h observation window, regardless of whether it was ever traded,
 * watched, or rejected outright. This — not the trades themselves — is the
 * core of the learning dataset the whole trading extension exists to build.
 */
export async function pollCandidateOutcomes(): Promise<number> {
  const cutoff = new Date(Date.now() - OBSERVATION_WINDOW_HOURS * 3_600_000);
  const candidates = await db.tradeCandidate.findMany({
    where: { createdAt: { gte: cutoff } },
    include: { token: true, outcome: true },
  });

  let updated = 0;
  for (const candidate of candidates) {
    try {
      if (await updateOutcomeForCandidate(candidate)) updated++;
    } catch (err) {
      logger.error({ candidateId: candidate.id, err: String(err) }, "candidate outcome poll failed");
    }
  }
  return updated;
}

async function updateOutcomeForCandidate(
  candidate: Awaited<ReturnType<typeof db.tradeCandidate.findMany>>[number] & {
    token: { chain: string; address: string };
    outcome: Awaited<ReturnType<typeof db.candidateOutcome.findUnique>>;
  }
): Promise<boolean> {
  const market = await pollCandidateMarket(candidate.tokenId, candidate.token.chain, candidate.token.address);
  const mcap = market.primaryPair?.marketCapUsd;
  if (mcap === undefined) return false;

  const ageMinutes = (Date.now() - candidate.createdAt.getTime()) / 60_000;
  const existing = candidate.outcome;
  const marketCapAtDetection = existing?.marketCapAtDetection ?? mcap;

  const windows = [
    { minutes: 15, active: ageMinutes <= 15 },
    { minutes: 60, active: ageMinutes <= 60 },
    { minutes: 360, active: ageMinutes <= 360 },
    { minutes: 1440, active: ageMinutes <= 1440 },
    { minutes: 2880, active: ageMinutes <= 2880 },
  ];

  const max15m = windows[0].active ? Math.max(existing?.maxMarketCap15m ?? 0, mcap) : existing?.maxMarketCap15m ?? undefined;
  const max1h = windows[1].active ? Math.max(existing?.maxMarketCap1h ?? 0, mcap) : existing?.maxMarketCap1h ?? undefined;
  const max6h = windows[2].active ? Math.max(existing?.maxMarketCap6h ?? 0, mcap) : existing?.maxMarketCap6h ?? undefined;
  const max24h = windows[3].active ? Math.max(existing?.maxMarketCap24h ?? 0, mcap) : existing?.maxMarketCap24h ?? undefined;
  const max48h = windows[4].active ? Math.max(existing?.maxMarketCap48h ?? 0, mcap) : existing?.maxMarketCap48h ?? undefined;

  const min15m = windows[0].active ? Math.min(existing?.minMarketCap15m ?? mcap, mcap) : existing?.minMarketCap15m ?? undefined;
  const min1h = windows[1].active ? Math.min(existing?.minMarketCap1h ?? mcap, mcap) : existing?.minMarketCap1h ?? undefined;
  const min6h = windows[2].active ? Math.min(existing?.minMarketCap6h ?? mcap, mcap) : existing?.minMarketCap6h ?? undefined;
  const min24h = windows[3].active ? Math.min(existing?.minMarketCap24h ?? mcap, mcap) : existing?.minMarketCap24h ?? undefined;
  const min48h = windows[4].active ? Math.min(existing?.minMarketCap48h ?? mcap, mcap) : existing?.minMarketCap48h ?? undefined;

  const maxMultiple24h = marketCapAtDetection > 0 && max24h !== undefined ? max24h / marketCapAtDetection : undefined;
  const maxMultiple48h = marketCapAtDetection > 0 && max48h !== undefined ? max48h / marketCapAtDetection : undefined;
  const maxDrawdown24h =
    marketCapAtDetection > 0 && min24h !== undefined ? ((min24h - marketCapAtDetection) / marketCapAtDetection) * 100 : undefined;

  const bestMultipleSoFar = Math.max(maxMultiple24h ?? 0, maxMultiple48h ?? 0, mcap / marketCapAtDetection);
  const rawHits = hitFlags(existing ?? undefined, bestMultipleSoFar);
  const feasiblePeak = await evaluateFeasiblePeak({
    tokenAddress: candidate.token.address,
    pair: market.primaryPair,
    marketCapAtDetection,
    currentMarketCap: mcap,
    existingFeasibleMultiple: Math.max(existing?.feasibleMaxMultiple24h ?? 0, existing?.feasibleMaxMultiple48h ?? 0),
  });
  const feasibleMaxMultiple24h =
    windows[3].active && feasiblePeak.feasible
      ? Math.max(existing?.feasibleMaxMultiple24h ?? 0, feasiblePeak.multiple)
      : existing?.feasibleMaxMultiple24h ?? undefined;
  const feasibleMaxMultiple48h =
    windows[4].active && feasiblePeak.feasible
      ? Math.max(existing?.feasibleMaxMultiple48h ?? 0, feasiblePeak.multiple)
      : existing?.feasibleMaxMultiple48h ?? undefined;
  const feasibleBestMultipleSoFar = Math.max(feasibleMaxMultiple24h ?? 0, feasibleMaxMultiple48h ?? 0);
  const feasibleHits = hitFlags(
    {
      hit125x: existing?.feasibleHit125x,
      hit150x: existing?.feasibleHit150x,
      hit200x: existing?.feasibleHit200x,
      hit250x: existing?.feasibleHit250x,
      hit500x: existing?.feasibleHit500x,
      hit1000x: existing?.feasibleHit1000x,
      hit2500x: existing?.feasibleHit2500x,
      hit5000x: existing?.feasibleHit5000x,
      hit10000x: existing?.feasibleHit10000x,
    },
    feasibleBestMultipleSoFar
  );

  const timeTo150xMinutes = !existing?.timeTo150xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit150x ? Math.round(ageMinutes) : existing?.timeTo150xMinutes;
  const timeTo200xMinutes = !existing?.timeTo200xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit200x ? Math.round(ageMinutes) : existing?.timeTo200xMinutes;
  const timeTo250xMinutes = !existing?.timeTo250xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit250x ? Math.round(ageMinutes) : existing?.timeTo250xMinutes;
  const timeTo500xMinutes = !existing?.timeTo500xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit500x ? Math.round(ageMinutes) : existing?.timeTo500xMinutes;
  const timeTo1000xMinutes = !existing?.timeTo1000xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit1000x ? Math.round(ageMinutes) : existing?.timeTo1000xMinutes;
  const timeTo2500xMinutes = !existing?.timeTo2500xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit2500x ? Math.round(ageMinutes) : existing?.timeTo2500xMinutes;
  const timeTo5000xMinutes = !existing?.timeTo5000xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit5000x ? Math.round(ageMinutes) : existing?.timeTo5000xMinutes;
  const timeTo10000xMinutes = !existing?.timeTo10000xMinutes && bestMultipleSoFar >= HIT_MULTIPLES.hit10000x ? Math.round(ageMinutes) : existing?.timeTo10000xMinutes;

  const data = {
    traded: candidate.status === TradeCandidateStatus.TRADED,
    marketCapAtDetection,
    marketCapAtPlan: existing?.marketCapAtPlan ?? undefined,
    maxMarketCap15m: max15m,
    maxMarketCap1h: max1h,
    maxMarketCap6h: max6h,
    maxMarketCap24h: max24h,
    maxMarketCap48h: max48h,
    minMarketCap15m: min15m,
    minMarketCap1h: min1h,
    minMarketCap6h: min6h,
    minMarketCap24h: min24h,
    minMarketCap48h: min48h,
    maxMultiple24h,
    maxMultiple48h,
    maxDrawdown24h,
    feasibleMaxMultiple24h,
    feasibleMaxMultiple48h,
    hit125x: rawHits.hit125x,
    hit150x: rawHits.hit150x,
    hit200x: rawHits.hit200x,
    hit250x: rawHits.hit250x,
    hit500x: rawHits.hit500x,
    hit1000x: rawHits.hit1000x,
    hit2500x: rawHits.hit2500x,
    hit5000x: rawHits.hit5000x,
    hit10000x: rawHits.hit10000x,
    feasibleHit125x: feasibleHits.hit125x,
    feasibleHit150x: feasibleHits.hit150x,
    feasibleHit200x: feasibleHits.hit200x,
    feasibleHit250x: feasibleHits.hit250x,
    feasibleHit500x: feasibleHits.hit500x,
    feasibleHit1000x: feasibleHits.hit1000x,
    feasibleHit2500x: feasibleHits.hit2500x,
    feasibleHit5000x: feasibleHits.hit5000x,
    feasibleHit10000x: feasibleHits.hit10000x,
    timeTo150xMinutes,
    timeTo200xMinutes,
    timeTo250xMinutes,
    timeTo500xMinutes,
    timeTo1000xMinutes,
    timeTo2500xMinutes,
    timeTo5000xMinutes,
    timeTo10000xMinutes,
    feasibleOutcomeReason: {
      lastCheckedAt: new Date().toISOString(),
      currentPeak: feasiblePeak.reasons,
    },
  };

  await db.candidateOutcome.upsert({
    where: { candidateId: candidate.id },
    create: { candidateId: candidate.id, ...data },
    update: data,
  });
  return true;
}
