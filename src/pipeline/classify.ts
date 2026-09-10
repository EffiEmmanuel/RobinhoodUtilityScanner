import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { callStructured, fetchImageAsBase64, type ImageInput } from "../ai/provider";
import { VisualClassificationSchema, VISUAL_CLASSIFICATION_JSON_SCHEMA, type VisualClassification } from "../ai/schemas";
import { VISUAL_CLASSIFIER_SYSTEM, buildVisualClassificationPrompt } from "../ai/prompts";
import { TokenStatus } from "../generated/prisma";
import { fetchMarketForToken } from "../dex/client";

export interface ClassifyOutcome {
  classification: VisualClassification;
  passed: boolean;
}

/**
 * FR-005/FR-007: cheap, fast visual+metadata gate before any deep research.
 * Branding quality deliberately does NOT gate here (a legitimate project with
 * an unattractive logo must not be rejected) — it still feeds the final score
 * at 5% weight (see scoring/index.ts). Only utility/meme probability gate.
 */
export async function classifyToken(tokenId: string): Promise<ClassifyOutcome> {
  const token = await db.token.findUniqueOrThrow({ where: { id: tokenId } });

  const images: ImageInput[] = [];
  for (const url of [token.iconUrl, token.headerUrl]) {
    if (!url) continue;
    const img = await fetchImageAsBase64(url);
    if (img) images.push(img);
  }

  const classification = await callStructured({
    model: config.classifierModel,
    system: VISUAL_CLASSIFIER_SYSTEM,
    prompt: buildVisualClassificationPrompt(token),
    schema: VisualClassificationSchema,
    jsonSchema: VISUAL_CLASSIFICATION_JSON_SCHEMA,
    toolName: "submit_visual_classification",
    images,
    maxTokens: 1000,
    // Not disabling thinking here: gemini-flash-lite-latest rejects
    // thinkingBudget: 0 with a generic 400 (confirmed live) even though the
    // SDK's types claim 0 is universally valid. Flash-lite is already the
    // cheap/fast tier, so the default (small, model-chosen) budget is fine.
  });

  const narrativePassed =
    classification.requiresResearch &&
    classification.utilityProbability >= config.minUtilityProbability &&
    classification.memeProbability <= config.maxMemeProbability;

  // Deterministic momentum override: real, already-observable trading demand
  // is itself evidence worth researching, regardless of the narrative
  // utility/meme verdict above. Confirmed live misses without this: tokens
  // rejected as "doesn't align with legitimate software/fintech" that went on
  // to run several multiples with hundreds of real traders. This never
  // bypasses deep research's own contract-safety/liquidity/hard-reject
  // checks — it only decides whether that research happens at all.
  let momentumOverride = false;
  let momentumReason: string | undefined;
  if (!narrativePassed) {
    const market = await fetchMarketForToken(token.chain, token.address).catch((err) => {
      logger.warn({ tokenId, err: String(err) }, "momentum-override market lookup failed — falling back to narrative verdict only");
      return undefined;
    });
    const pair = market?.primaryPair;
    const hourlyTxns = (pair?.buys1h ?? 0) + (pair?.sells1h ?? 0);
    const liquidityUsd = pair?.liquidityUsd ?? 0;
    if (liquidityUsd >= config.momentumOverrideMinLiquidityUsd && hourlyTxns >= config.momentumOverrideMinHourlyTxns) {
      momentumOverride = true;
      momentumReason = `Momentum override: $${Math.round(liquidityUsd).toLocaleString()} liquidity and ${hourlyTxns} txns/1h despite narrative rejection (utility ${(classification.utilityProbability * 100).toFixed(0)}%, meme ${(classification.memeProbability * 100).toFixed(0)}%) — real trading demand is proceeding to research regardless.`;
      logger.info({ tokenId, address: token.address, liquidityUsd, hourlyTxns }, "classification narrative-rejected but passed via momentum override");
    }
  }

  const passed = narrativePassed || momentumOverride;

  await db.classification.create({
    data: {
      tokenId,
      utilityProbability: classification.utilityProbability,
      memeProbability: classification.memeProbability,
      brandingQuality: classification.brandingQuality,
      professionalism: classification.professionalism,
      visualSpamProbability: classification.visualSpamProbability,
      passed,
      reasoningSummary: momentumReason ? [...classification.reasoningSummary, momentumReason] : classification.reasoningSummary,
      model: config.classifierModel,
    },
  });

  await db.token.update({
    where: { id: tokenId },
    data: { status: passed ? TokenStatus.RESEARCH_QUEUED : TokenStatus.REJECTED },
  });

  logger.info(
    { tokenId, address: token.address, passed, utility: classification.utilityProbability, meme: classification.memeProbability },
    "visual classification complete"
  );

  return { classification, passed };
}
