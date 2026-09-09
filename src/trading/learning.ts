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

export type OutcomeLabel = "hit125x" | "hit150x" | "hit200x" | "hit250x";

const FEATURE_NAMES = [
  "qualityScore",
  "researchConfidence",
  "contractScore",
  "utilityScore",
  "websiteScore",
  "socialScore",
  "brandingScore",
  "teamScore",
  "liquidityUsd",
  "marketCapAtDetection",
  "liquidityToMcapRatio",
] as const;
type FeatureName = (typeof FEATURE_NAMES)[number];

export interface FeatureRow {
  candidateId: string;
  traded: boolean;
  qualityScore?: number;
  researchConfidence?: number;
  contractScore?: number;
  utilityScore?: number;
  websiteScore?: number;
  socialScore?: number;
  brandingScore?: number;
  teamScore?: number;
  liquidityUsd?: number;
  marketCapAtDetection?: number;
  liquidityToMcapRatio?: number;
  hit125x: boolean;
  hit150x: boolean;
  hit200x: boolean;
  hit250x: boolean;
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
      const rawResearch = run?.rawResearch as { market?: { primaryPair?: { liquidityUsd?: number } } } | undefined;
      const liquidityUsd = rawResearch?.market?.primaryPair?.liquidityUsd;
      const marketCapAtDetection = c.outcome!.marketCapAtDetection ?? undefined;

      return {
        candidateId: c.id,
        traded: c.outcome!.traded,
        qualityScore: c.qualityScore ?? undefined,
        researchConfidence: c.researchConfidence ?? undefined,
        contractScore: run?.contractScore ?? undefined,
        utilityScore: run?.utilityScore ?? undefined,
        websiteScore: run?.websiteScore ?? undefined,
        socialScore: run?.socialScore ?? undefined,
        brandingScore: run?.brandingScore ?? undefined,
        teamScore: run?.teamScore ?? undefined,
        liquidityUsd,
        marketCapAtDetection,
        liquidityToMcapRatio: liquidityUsd && marketCapAtDetection ? liquidityUsd / marketCapAtDetection : undefined,
        hit125x: c.outcome!.hit125x ?? false,
        hit150x: c.outcome!.hit150x ?? false,
        hit200x: c.outcome!.hit200x ?? false,
        hit250x: c.outcome!.hit250x ?? false,
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
