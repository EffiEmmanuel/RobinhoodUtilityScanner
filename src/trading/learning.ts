import { db } from "../db";
import { logger } from "../logger";

/**
 * §62-§66 — the feature dataset + a lean, dependency-free learning layer.
 * Deliberately NOT a heavyweight ML library: §65 says "do not begin with deep
 * learning," and at the data volumes this system will actually have for a
 * long time (§66's own thresholds — <50 candidates is "analytics only"),
 * pulling in TensorFlow.js or similar would be pure ceremony over a
 * from-scratch logistic regression that fits in one file and is fully
 * auditable. Nothing here ever feeds back into planning.ts/riskEngine.ts —
 * outputs are a recommendation surface only (§65: "AI lessons cannot
 * directly alter production strategy").
 */

export type OutcomeLabel = "hit125x" | "hit150x" | "hit200x" | "hit250x" | "hit500x" | "hit1000x" | "hit2500x" | "hit5000x" | "hit10000x";

const FEATURE_NAMES = [
  "qualityScore",
  "researchConfidence",
  "contractScore",
  "utilityScore",
  "credibilityScore",
  "websiteScore",
  "socialScore",
  "liquidityScore",
  "marketScore",
  "holderScore",
  "brandingScore",
  "teamScore",
  "liquidityUsd",
  "marketCapAtDetection",
  "liquidityToMcapRatio",
  "hourlyTxns",
  "buyRatio1h",
  "volumeToLiquidity1h",
  "tradeLaneVerified",
  "tradeLaneTactical",
  "qualificationMomentumOverride",
] as const;
type FeatureName = (typeof FEATURE_NAMES)[number];

export interface FeatureRow {
  candidateId: string;
  traded: boolean;
  // How the candidate cleared evaluateCandidate — "NORMAL" or
  // "MOMENTUM_OVERRIDE" (see TradeCandidate.qualificationPath). Undefined
  // for anything created before this field existed, or anything that never
  // actually qualified (a REJECTED candidate can still have an outcome).
  qualificationPath?: string;
  tradeLane?: string;
  qualityScore?: number;
  researchConfidence?: number;
  contractScore?: number;
  utilityScore?: number;
  credibilityScore?: number;
  websiteScore?: number;
  socialScore?: number;
  liquidityScore?: number;
  marketScore?: number;
  holderScore?: number;
  brandingScore?: number;
  teamScore?: number;
  liquidityUsd?: number;
  marketCapAtDetection?: number;
  liquidityToMcapRatio?: number;
  hourlyTxns?: number;
  buyRatio1h?: number;
  volumeToLiquidity1h?: number;
  tradeLaneVerified?: number;
  tradeLaneTactical?: number;
  qualificationMomentumOverride?: number;
  hit125x: boolean;
  hit150x: boolean;
  hit200x: boolean;
  hit250x: boolean;
  hit500x: boolean;
  hit1000x: boolean;
  hit2500x: boolean;
  hit5000x: boolean;
  hit10000x: boolean;
  maxDrawdown24h?: number;
}

/**
 * §61 — every candidate becomes one row, traded or not: a rejected candidate
 * that later 10x'd is exactly as valuable here as a traded winner.
 */
export async function exportFeatureDataset(): Promise<FeatureRow[]> {
  const candidates = await db.tradeCandidate.findMany({
    where: { outcome: { isNot: null } },
    include: {
      outcome: true,
      token: { include: { researchRuns: { orderBy: { createdAt: "desc" }, take: 1 } } },
    },
  });

  return candidates
    .filter((c) => c.outcome)
    .map((c) => {
      const run = c.token.researchRuns[0];
      const rawResearch = run?.rawResearch as
        | {
            market?: {
              primaryPair?: {
                liquidityUsd?: number;
                volume1h?: number;
                buys1h?: number;
                sells1h?: number;
              };
            };
          }
        | undefined;
      const primaryPair = rawResearch?.market?.primaryPair;
      const liquidityUsd = primaryPair?.liquidityUsd;
      const marketCapAtDetection = c.outcome!.marketCapAtDetection ?? undefined;
      const hourlyTxns = primaryPair?.buys1h !== undefined || primaryPair?.sells1h !== undefined ? (primaryPair?.buys1h ?? 0) + (primaryPair?.sells1h ?? 0) : undefined;
      const buyRatio1h = hourlyTxns && hourlyTxns > 0 ? (primaryPair?.buys1h ?? 0) / hourlyTxns : undefined;
      const volumeToLiquidity1h = liquidityUsd && liquidityUsd > 0 && primaryPair?.volume1h !== undefined ? primaryPair.volume1h / liquidityUsd : undefined;
      const tradeLane = c.tradeLane ?? undefined;
      const qualificationPath = c.qualificationPath ?? undefined;

      return {
        candidateId: c.id,
        traded: c.outcome!.traded,
        qualificationPath,
        tradeLane,
        qualityScore: c.qualityScore ?? undefined,
        researchConfidence: c.researchConfidence ?? undefined,
        contractScore: run?.contractScore ?? undefined,
        utilityScore: run?.utilityScore ?? undefined,
        credibilityScore: run?.credibilityScore ?? undefined,
        websiteScore: run?.websiteScore ?? undefined,
        socialScore: run?.socialScore ?? undefined,
        liquidityScore: run?.liquidityScore ?? undefined,
        marketScore: run?.marketScore ?? undefined,
        holderScore: run?.holderScore ?? undefined,
        brandingScore: run?.brandingScore ?? undefined,
        teamScore: run?.teamScore ?? undefined,
        liquidityUsd,
        marketCapAtDetection,
        liquidityToMcapRatio: liquidityUsd && marketCapAtDetection ? liquidityUsd / marketCapAtDetection : undefined,
        hourlyTxns,
        buyRatio1h,
        volumeToLiquidity1h,
        tradeLaneVerified: tradeLane === "VERIFIED_PROJECT" ? 1 : 0,
        tradeLaneTactical: tradeLane === "MOMENTUM_TACTICAL" ? 1 : 0,
        qualificationMomentumOverride: qualificationPath === "MOMENTUM_OVERRIDE" ? 1 : 0,
        hit125x: c.outcome!.hit125x ?? false,
        hit150x: c.outcome!.hit150x ?? false,
        hit200x: c.outcome!.hit200x ?? false,
        hit250x: c.outcome!.hit250x ?? false,
        hit500x: c.outcome!.hit500x ?? false,
        hit1000x: c.outcome!.hit1000x ?? false,
        hit2500x: c.outcome!.hit2500x ?? false,
        hit5000x: c.outcome!.hit5000x ?? false,
        hit10000x: c.outcome!.hit10000x ?? false,
        maxDrawdown24h: c.outcome!.maxDrawdown24h ?? undefined,
      };
    });
}

// §66 — candidates, not only executed trades, count toward the dataset.
export type DataTier = "ANALYTICS_ONLY" | "EXPLORATORY" | "VALIDATED" | "STRONG";
export function getDataTier(sampleSize: number): DataTier {
  if (sampleSize < 50) return "ANALYTICS_ONLY";
  if (sampleSize < 200) return "EXPLORATORY";
  if (sampleSize < 1000) return "VALIDATED";
  return "STRONG";
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom === 0 ? 0 : numerator / denom;
}

export function computeFeatureCorrelations(rows: FeatureRow[], target: OutcomeLabel): Record<FeatureName, number | null> {
  const targetValues = rows.map((r) => (r[target] ? 1 : 0));
  const correlations = {} as Record<FeatureName, number | null>;
  for (const feature of FEATURE_NAMES) {
    const pairedX: number[] = [];
    const pairedY: number[] = [];
    rows.forEach((row, i) => {
      const value = row[feature];
      if (value !== undefined && !Number.isNaN(value)) {
        pairedX.push(value);
        pairedY.push(targetValues[i]);
      }
    });
    correlations[feature] = pairedX.length >= 5 ? pearsonCorrelation(pairedX, pairedY) : null;
  }
  return correlations;
}

/**
 * "Learn which entry pathway actually pays" (user directive 2026-09-11).
 * qualificationPath is categorical, not numeric, so it doesn't fit
 * computeFeatureCorrelations' Pearson-correlation approach above — this is
 * the direct equivalent for a categorical split: hit-rate per path per
 * outcome target, plus the raw sample size so a caller can judge how much
 * to trust each row (§66 — a 3-sample path's 100% hit rate means nothing).
 */
export interface QualificationPathRate {
  path: string;
  sampleSize: number;
  hitRate: number;
}
export function computeOutcomeRateByQualificationPath(rows: FeatureRow[], target: OutcomeLabel): QualificationPathRate[] {
  const byPath = new Map<string, FeatureRow[]>();
  for (const row of rows) {
    const path = row.qualificationPath ?? "UNKNOWN";
    const group = byPath.get(path);
    if (group) group.push(row);
    else byPath.set(path, [row]);
  }
  return Array.from(byPath.entries())
    .map(([path, group]) => ({
      path,
      sampleSize: group.length,
      hitRate: group.filter((r) => r[target]).length / group.length,
    }))
    .sort((a, b) => b.sampleSize - a.sampleSize);
}

export interface TradeLaneRate {
  lane: string;
  sampleSize: number;
  hitRate: number;
}
export function computeOutcomeRateByTradeLane(rows: FeatureRow[], target: OutcomeLabel): TradeLaneRate[] {
  const byLane = new Map<string, FeatureRow[]>();
  for (const row of rows) {
    const lane = row.tradeLane ?? "UNKNOWN";
    const group = byLane.get(lane);
    if (group) group.push(row);
    else byLane.set(lane, [row]);
  }
  return Array.from(byLane.entries())
    .map(([lane, group]) => ({
      lane,
      sampleSize: group.length,
      hitRate: group.filter((r) => r[target]).length / group.length,
    }))
    .sort((a, b) => b.sampleSize - a.sampleSize);
}

// --- Lean logistic regression (gradient descent), no external ML library ---

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

interface TrainedLogisticModel {
  weights: number[];
  bias: number;
  means: number[];
  stds: number[];
  trainAccuracy: number;
}

function trainLogisticRegression(X: number[][], y: number[], learningRate = 0.1, epochs = 2000): TrainedLogisticModel {
  const nSamples = X.length;
  const nFeatures = X[0]?.length ?? 0;
  const means: number[] = [];
  const stds: number[] = [];
  const standardized: number[][] = X.map((row) => [...row]);

  for (let f = 0; f < nFeatures; f++) {
    const column = X.map((row) => row[f]);
    const mean = column.reduce((a, b) => a + b, 0) / nSamples;
    const variance = column.reduce((a, b) => a + (b - mean) ** 2, 0) / nSamples;
    const std = Math.sqrt(variance) || 1;
    means.push(mean);
    stds.push(std);
    for (let i = 0; i < nSamples; i++) standardized[i][f] = (X[i][f] - mean) / std;
  }

  const weights = new Array(nFeatures).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(nFeatures).fill(0);
    let gradB = 0;
    for (let i = 0; i < nSamples; i++) {
      const z = standardized[i].reduce((sum, x, f) => sum + x * weights[f], bias);
      const error = sigmoid(z) - y[i];
      for (let f = 0; f < nFeatures; f++) gradW[f] += error * standardized[i][f];
      gradB += error;
    }
    for (let f = 0; f < nFeatures; f++) weights[f] -= (learningRate * gradW[f]) / nSamples;
    bias -= (learningRate * gradB) / nSamples;
  }

  let correct = 0;
  for (let i = 0; i < nSamples; i++) {
    const z = standardized[i].reduce((sum, x, f) => sum + x * weights[f], bias);
    if ((sigmoid(z) >= 0.5 ? 1 : 0) === y[i]) correct++;
  }

  return { weights, bias, means, stds, trainAccuracy: nSamples > 0 ? correct / nSamples : 0 };
}

const MIN_COMPLETE_ROWS_TO_TRAIN = 20;

/**
 * §66's gate, enforced in code, not just documentation: below 50 total
 * candidates this returns correlations only — no trained model, no
 * false confidence from a model fit on a handful of points.
 */
export async function trainOrAnalyze(targetLabel: OutcomeLabel) {
  const rows = await exportFeatureDataset();
  const dataTier = getDataTier(rows.length);

  if (dataTier === "ANALYTICS_ONLY") {
    const correlations = computeFeatureCorrelations(rows, targetLabel);
    return db.mLModelVersion.create({
      data: {
        name: `${targetLabel}-correlations`,
        targetLabel,
        sampleSize: rows.length,
        dataTier,
        featureNames: FEATURE_NAMES as unknown as object,
        correlations: correlations as unknown as object,
      },
    });
  }

  const completeRows = rows.filter((r) => FEATURE_NAMES.every((f) => r[f] !== undefined));
  if (completeRows.length < MIN_COMPLETE_ROWS_TO_TRAIN) {
    logger.warn(
      { targetLabel, totalRows: rows.length, completeRows: completeRows.length },
      "not enough complete-feature rows to train despite total sample size — falling back to correlations"
    );
    const correlations = computeFeatureCorrelations(rows, targetLabel);
    return db.mLModelVersion.create({
      data: {
        name: `${targetLabel}-correlations-fallback`,
        targetLabel,
        sampleSize: rows.length,
        dataTier: "ANALYTICS_ONLY",
        featureNames: FEATURE_NAMES as unknown as object,
        correlations: correlations as unknown as object,
      },
    });
  }

  const X = completeRows.map((r) => FEATURE_NAMES.map((f) => r[f] as number));
  const y = completeRows.map((r) => (r[targetLabel] ? 1 : 0));
  const model = trainLogisticRegression(X, y);

  const saved = await db.mLModelVersion.create({
    data: {
      name: `${targetLabel}-logistic-regression`,
      targetLabel,
      sampleSize: completeRows.length,
      dataTier,
      featureNames: FEATURE_NAMES as unknown as object,
      coefficients: { weights: model.weights, bias: model.bias, means: model.means, stds: model.stds } as unknown as object,
      trainAccuracy: model.trainAccuracy,
    },
  });
  logger.info({ modelId: saved.id, targetLabel, sampleSize: completeRows.length, trainAccuracy: model.trainAccuracy }, "ML model trained");
  return saved;
}

/** Applies a saved model to a fresh feature vector — informational only. */
export async function predict(modelId: string, features: Partial<Record<FeatureName, number>>): Promise<number | undefined> {
  const model = await db.mLModelVersion.findUniqueOrThrow({ where: { id: modelId } });
  if (!model.coefficients) return undefined; // ANALYTICS_ONLY models have no trained coefficients to apply
  const { weights, bias, means, stds } = model.coefficients as { weights: number[]; bias: number; means: number[]; stds: number[] };
  const featureNames = model.featureNames as string[];
  let z = bias;
  for (let f = 0; f < featureNames.length; f++) {
    const raw = features[featureNames[f] as FeatureName];
    if (raw === undefined) return undefined; // refuse to guess a missing feature rather than silently zero-filling it
    z += ((raw - means[f]) / stds[f]) * weights[f];
  }
  return sigmoid(z);
}
