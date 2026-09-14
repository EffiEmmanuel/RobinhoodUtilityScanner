import { db } from "../db";
import { logger } from "../logger";
import { TradeCandidateStatus } from "../generated/prisma";
import { pollCandidateMarket } from "./marketAnalysis";

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
  const hit125x = existing?.hit125x || bestMultipleSoFar >= HIT_MULTIPLES.hit125x;
  const hit150x = existing?.hit150x || bestMultipleSoFar >= HIT_MULTIPLES.hit150x;
  const hit200x = existing?.hit200x || bestMultipleSoFar >= HIT_MULTIPLES.hit200x;
  const hit250x = existing?.hit250x || bestMultipleSoFar >= HIT_MULTIPLES.hit250x;
  const hit500x = existing?.hit500x || bestMultipleSoFar >= HIT_MULTIPLES.hit500x;
  const hit1000x = existing?.hit1000x || bestMultipleSoFar >= HIT_MULTIPLES.hit1000x;
  const hit2500x = existing?.hit2500x || bestMultipleSoFar >= HIT_MULTIPLES.hit2500x;
  const hit5000x = existing?.hit5000x || bestMultipleSoFar >= HIT_MULTIPLES.hit5000x;
  const hit10000x = existing?.hit10000x || bestMultipleSoFar >= HIT_MULTIPLES.hit10000x;

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
    hit125x,
    hit150x,
    hit200x,
    hit250x,
    hit500x,
    hit1000x,
    hit2500x,
    hit5000x,
    hit10000x,
    timeTo150xMinutes,
    timeTo200xMinutes,
    timeTo250xMinutes,
    timeTo500xMinutes,
    timeTo1000xMinutes,
    timeTo2500xMinutes,
    timeTo5000xMinutes,
    timeTo10000xMinutes,
  };

  await db.candidateOutcome.upsert({
    where: { candidateId: candidate.id },
    create: { candidateId: candidate.id, ...data },
    update: data,
  });
  return true;
}
