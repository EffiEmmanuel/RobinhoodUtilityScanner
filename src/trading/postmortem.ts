import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { callStructured } from "../ai/provider";
import { PostmortemAnalysisSchema, POSTMORTEM_JSON_SCHEMA } from "./schemas";
import { POSTMORTEM_SYSTEM, buildPostmortemPrompt } from "./prompts";

/**
 * §72 — best-effort: a postmortem failing must never block trade closure
 * (closeTrade in positionManager.ts already committed the CLOSED status
 * before calling this). Lessons are stored for human review only.
 */
export async function generatePostmortem(tradeId: string): Promise<void> {
  const trade = await db.trade.findUniqueOrThrow({ where: { id: tradeId }, include: { tradePlan: true } });
  const token = await db.token.findUnique({ where: { id: trade.tokenId } });

  const holdingMinutes =
    trade.openedAt && trade.closedAt ? Math.round((trade.closedAt.getTime() - trade.openedAt.getTime()) / 60_000) : undefined;

  const snapshots = await db.positionSnapshot.findMany({ where: { tradeId }, orderBy: { capturedAt: "asc" } });
  const peakSnapshot = snapshots.reduce<(typeof snapshots)[number] | undefined>(
    (best, s) => (s.unrealizedPnlPercent !== null && (best === undefined || (s.unrealizedPnlPercent ?? -Infinity) > (best.unrealizedPnlPercent ?? -Infinity)) ? s : best),
    undefined
  );
  const timeToPeakMinutes =
    peakSnapshot && trade.openedAt ? Math.round((peakSnapshot.capturedAt.getTime() - trade.openedAt.getTime()) / 60_000) : undefined;
  const exitMcap = snapshots.length > 0 ? snapshots[snapshots.length - 1].marketCapUsd ?? undefined : undefined;

  const planData = trade.tradePlan?.planData as { analysis?: { reasoning?: string[] } } | undefined;

  let analysis;
  try {
    analysis = await callStructured({
      model: config.researchModel,
      system: POSTMORTEM_SYSTEM,
      prompt: buildPostmortemPrompt({
        token,
        planReasoning: planData?.analysis?.reasoning ?? [],
        entryMcap: trade.actualEntryMcap ?? undefined,
        exitMcap,
        realizedMultiple: trade.realizedMultiple ?? undefined,
        mfePercent: trade.mfePercent ?? undefined,
        maePercent: trade.maePercent ?? undefined,
        holdingMinutes,
        exitReason: trade.exitReason ?? undefined,
      }),
      schema: PostmortemAnalysisSchema,
      jsonSchema: POSTMORTEM_JSON_SCHEMA,
      toolName: "submit_postmortem",
      maxTokens: 2000,
    });
  } catch (err) {
    logger.error({ tradeId, err: String(err) }, "postmortem AI call failed — skipping (trade remains CLOSED)");
    return;
  }

  await db.tradePostmortem.create({
    data: {
      tradeId,
      result: analysis.result,
      entryQuality: analysis.entryQuality,
      exitQuality: analysis.exitQuality,
      realizedMultiple: trade.realizedMultiple ?? undefined,
      mfeMultiple: trade.mfePercent !== null ? 1 + trade.mfePercent / 100 : undefined,
      maePercent: trade.maePercent ?? undefined,
      timeToPeakMinutes,
      holdingMinutes,
      whatWorked: analysis.whatWorked,
      whatFailed: analysis.whatFailed,
      missedOpportunity: analysis.missedOpportunity,
      lessons: analysis.lessons,
      aiSummary: analysis.summary,
    },
  });

  logger.info({ tradeId, result: analysis.result }, "postmortem generated");
}
