import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { callStructured } from "../ai/provider";
import { PostmortemAnalysisSchema, POSTMORTEM_JSON_SCHEMA } from "./schemas";
import { POSTMORTEM_SYSTEM, buildPostmortemPrompt } from "./prompts";
import { normalizeTradeLane } from "./tradeLane";

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
  const deterministicTags = buildDeterministicPostmortemTags({
    trade,
    snapshots,
    holdingMinutes,
  });

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
      deterministicTags,
      missedOpportunity: analysis.missedOpportunity,
      lessons: analysis.lessons,
      aiSummary: analysis.summary,
    },
  });

  logger.info({ tradeId, result: analysis.result }, "postmortem generated");
}

function buildDeterministicPostmortemTags(input: {
  trade: Awaited<ReturnType<typeof db.trade.findUniqueOrThrow>>;
  snapshots: Awaited<ReturnType<typeof db.positionSnapshot.findMany>>;
  holdingMinutes: number | undefined;
}): string[] {
  const { trade, snapshots, holdingMinutes } = input;
  const tags = new Set<string>();
  const realizedMultiple = trade.realizedMultiple ?? 1;
  const mfePercent = trade.mfePercent ?? 0;
  const maePercent = trade.maePercent ?? 0;
  const exitReason = (trade.exitReason ?? "").toLowerCase();
  const lane = normalizeTradeLane(trade.tradeLane);

  tags.add(
    lane === "VERIFIED_PROJECT"
      ? "LANE_VERIFIED_PROJECT"
      : lane === "NARRATIVE_TACTICAL"
        ? "LANE_NARRATIVE_TACTICAL"
        : "LANE_MOMENTUM_TACTICAL"
  );
  if (realizedMultiple < 1) tags.add("LOSS");
  if (realizedMultiple >= 2) tags.add("REALIZED_2X_PLUS");
  if (mfePercent >= 100 && realizedMultiple < 1.5) tags.add("GAVE_BACK_BIG_WINNER");
  if (mfePercent >= 400 && realizedMultiple < 3) tags.add("MISSED_MOONBAG");
  if (maePercent <= -30) tags.add("DEEP_DRAWDOWN");
  if (exitReason.includes("invalidation")) tags.add("TECHNICAL_INVALIDATION");
  if (exitReason.includes("sell pressure")) tags.add("SELL_PRESSURE_EXIT");
  if (exitReason.includes("trailing")) tags.add("TRAILING_EXIT");
  if (exitReason.includes("max loss") || exitReason.includes("catastrophic")) tags.add("STOP_LOSS");
  if (exitReason.includes("failing to sell") || exitReason.includes("honeypot") || exitReason.includes("transfer")) tags.add("EXECUTION_TRAP");
  if (holdingMinutes !== undefined && holdingMinutes < 10 && realizedMultiple < 1) tags.add("FAST_LOSS");

  const first = snapshots[0];
  const last = snapshots[snapshots.length - 1];
  if (first?.liquidityUsd && last?.liquidityUsd && first.liquidityUsd > 0) {
    const liquidityChange = ((last.liquidityUsd - first.liquidityUsd) / first.liquidityUsd) * 100;
    if (liquidityChange <= -25) tags.add("LIQUIDITY_REMOVED");
  }
  const firstMcap = first?.marketCapUsd;
  const entryMcap = trade.actualEntryMcap;
  if (entryMcap && firstMcap && entryMcap > firstMcap * 1.3 && realizedMultiple < 1) tags.add("CHASED_EXTENSION");

  return [...tags].sort();
}
