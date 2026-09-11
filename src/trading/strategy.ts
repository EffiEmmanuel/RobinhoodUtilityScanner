import { db } from "../db";
import { logger } from "../logger";
import { StrategyStatus } from "../generated/prisma";
import { WEIGHTS } from "../scoring";
import { tradingConfig } from "./config";

export interface ProfitStep {
  multiple: number;
  sellPercentOfRemaining: number;
}

export interface SizingRules {
  baseAllocationPercent: number; // % of deployable capital for a "normal" (medium risk, medium confidence) position
  qualityMultiplierMin: number;
  qualityMultiplierMax: number;
  confidenceMultiplierMin: number;
  confidenceMultiplierMax: number;
  riskMultiplierLow: number;
  riskMultiplierMedium: number;
  riskMultiplierHigh: number;
  liquidityMultiplierMin: number;
  liquidityMultiplierMax: number;
}

export interface ExitRules {
  profitSteps: ProfitStep[];
  trailRemaining: boolean;
  trailingActivationMultiple: number;
  trailingPercent: number;
  maxLossPercent: number;
  catastrophicLossPercent: number;
  maxHoldMinutes: number;
  // Two independent reasons a trade gets the tighter profile below instead
  // of the normal one above — either is sufficient on its own:
  //
  // 1. The candidate only cleared eligibility on real trading demand (the
  //    momentum override — qualityScore and/or researchConfidence below
  //    qualityScoreThreshold, see riskEngine.ts), not on its own merits —
  //    it's a speculative ride on momentum someone else started, and every
  //    minute spent holding it past the point real buying pressure fades is
  //    a minute spent being exit liquidity for whoever bought before us.
  //
  // 2. Entry market cap was already above largeMcapUsd — a token that large
  //    has far less room left to run than one caught at tens/hundreds of
  //    thousands (confirmed live 2026-09-11: PEG $51K entry -> ~4x, TFLY
  //    $195K -> 2x+, vs RWA/STONKBROKER both already $20-30M entry and
  //    neither delivered a comparable multiple) — UNLESS qualityScore also
  //    clears the higher veryGoodQualityScoreThreshold, meaning this is a
  //    genuinely strong project worth holding long-term regardless of the
  //    market cap already paid to get in.
  //
  // positionManager.ts's resolveExitRules applies this. undefined (the
  // default until a strategy version sets it) disables the distinction
  // entirely and every trade uses the profile above, unchanged from before
  // this field existed.
  fastFlip?: {
    qualityScoreThreshold: number;
    largeMcapUsd: number;
    veryGoodQualityScoreThreshold: number;
    profitSteps: ProfitStep[];
    trailingActivationMultiple: number;
    trailingPercent: number;
    maxHoldMinutes: number;
  };
}

export interface EntryRules {
  pullbackExtendedThresholdPercent: number; // price this far above recent swing low => "extended", prefer pullback entry
  doNotChaseAboveMultiplePastTarget: number; // e.g. 1.15 = don't chase more than 15% above the top of the target zone
}

export interface StrategyConfiguration {
  minTradeQualityScore: number;
  minTradeResearchConfidence: number;
  minTradeContractScore: number;
  minTradeLiquidityUsd: number;
  defaultEntryPlanTtlMinutes: number;
}

const DEFAULT_NAME = "default";
const DEFAULT_VERSION = "v1.0";

// Mirrors the PRD's own worked examples (§35/§39) — a reasonable starting
// point, not a tuned strategy. Change by creating a NEW StrategyVersion, never
// by editing this file's defaults in place once real trades reference v1.0.
function buildDefaultConfiguration(): {
  configuration: StrategyConfiguration;
  entryRules: EntryRules;
  sizingRules: SizingRules;
  exitRules: ExitRules;
} {
  return {
    configuration: {
      minTradeQualityScore: tradingConfig.minTradeQualityScore,
      minTradeResearchConfidence: tradingConfig.minTradeResearchConfidence,
      minTradeContractScore: tradingConfig.minTradeContractScore,
      minTradeLiquidityUsd: tradingConfig.minTradeLiquidityUsd,
      defaultEntryPlanTtlMinutes: tradingConfig.defaultEntryPlanTtlMinutes,
    },
    entryRules: {
      pullbackExtendedThresholdPercent: 15,
      doNotChaseAboveMultiplePastTarget: 1.15,
    },
    sizingRules: {
      baseAllocationPercent: 10,
      qualityMultiplierMin: 0.6,
      qualityMultiplierMax: 1.3,
      confidenceMultiplierMin: 0.6,
      confidenceMultiplierMax: 1.2,
      riskMultiplierLow: 1.2,
      riskMultiplierMedium: 1.0,
      riskMultiplierHigh: 0.5,
      liquidityMultiplierMin: 0.5,
      liquidityMultiplierMax: 1.2,
    },
    exitRules: {
      profitSteps: [
        { multiple: 2.0, sellPercentOfRemaining: 50 },
        { multiple: 2.5, sellPercentOfRemaining: 30 },
      ],
      trailRemaining: true,
      trailingActivationMultiple: 1.6,
      trailingPercent: 20,
      maxLossPercent: 25,
      catastrophicLossPercent: 40,
      maxHoldMinutes: tradingConfig.defaultMaxHoldMinutes,
    },
  };
}

let cachedActiveVersionId: string | undefined;

/**
 * Get-or-create the default strategy version and return it as the "active"
 * one for new plans/trades. Later versions (v1.1, v2.0, ...) are created and
 * promoted explicitly via the API (see promoteStrategyVersion) — never
 * silently swapped in here.
 */
export async function getActiveStrategyVersion() {
  if (cachedActiveVersionId) {
    const cached = await db.strategyVersion.findUnique({ where: { id: cachedActiveVersionId } });
    if (cached) return cached;
  }

  // PRODUCTION outranks SHADOW if somehow both exist.
  const active =
    (await db.strategyVersion.findFirst({ where: { status: StrategyStatus.PRODUCTION }, orderBy: { createdAt: "desc" } })) ??
    (await db.strategyVersion.findFirst({ where: { status: StrategyStatus.SHADOW }, orderBy: { createdAt: "desc" } }));
  if (active) {
    cachedActiveVersionId = active.id;
    return active;
  }

  const defaults = buildDefaultConfiguration();
  const created = await db.strategyVersion.create({
    data: {
      name: DEFAULT_NAME,
      version: DEFAULT_VERSION,
      status: StrategyStatus.SHADOW,
      configuration: defaults.configuration as unknown as object,
      scoringWeights: WEIGHTS as unknown as object,
      entryRules: defaults.entryRules as unknown as object,
      sizingRules: defaults.sizingRules as unknown as object,
      exitRules: defaults.exitRules as unknown as object,
    },
  });
  logger.info({ id: created.id, name: created.name, version: created.version }, "seeded default strategy version");
  cachedActiveVersionId = created.id;
  return created;
}

const VALID_TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  [StrategyStatus.DRAFT]: [StrategyStatus.BACKTEST],
  [StrategyStatus.BACKTEST]: [StrategyStatus.SHADOW, StrategyStatus.DRAFT],
  [StrategyStatus.SHADOW]: [StrategyStatus.PRODUCTION, StrategyStatus.DRAFT],
  [StrategyStatus.PRODUCTION]: [StrategyStatus.RETIRED],
  [StrategyStatus.RETIRED]: [],
};

/**
 * Explicit, human-triggered promotion only (§68: "Never allow an LLM to
 * auto-promote a strategy") — this is called from an API endpoint, never
 * from the planning/trading loops themselves.
 */
export async function promoteStrategyVersion(id: string, toStatus: StrategyStatus) {
  const version = await db.strategyVersion.findUniqueOrThrow({ where: { id } });
  if (!VALID_TRANSITIONS[version.status].includes(toStatus)) {
    throw new Error(`Invalid strategy transition ${version.status} -> ${toStatus}`);
  }
  if (toStatus === StrategyStatus.PRODUCTION) {
    // Only one PRODUCTION version at a time — retire the current one.
    await db.strategyVersion.updateMany({
      where: { status: StrategyStatus.PRODUCTION },
      data: { status: StrategyStatus.RETIRED },
    });
  }
  const updated = await db.strategyVersion.update({
    where: { id },
    data: { status: toStatus, promotedAt: toStatus === StrategyStatus.PRODUCTION ? new Date() : version.promotedAt },
  });
  cachedActiveVersionId = undefined;
  return updated;
}
