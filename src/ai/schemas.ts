import { z } from "zod";

export const VisualClassificationSchema = z.object({
  utilityProbability: z.number().min(0).max(1),
  memeProbability: z.number().min(0).max(1),
  brandingQuality: z.number().min(0).max(1),
  professionalism: z.number().min(0).max(1),
  visualSpamProbability: z.number().min(0).max(1),
  requiresResearch: z.boolean(),
  reasoningSummary: z.array(z.string()).max(8),
});
export type VisualClassification = z.infer<typeof VisualClassificationSchema>;

// Hand-written JSON Schema companion for the Gemini function-call tool (see
// ai/provider.ts) — passed via `parametersJsonSchema`, which accepts standard
// JSON Schema directly. zod-to-json-schema hits a TS type-instantiation-depth
// wall with this zod/TS combo, and there are only two schemas in this app, so
// keeping both in sync by hand is simpler than fighting the generic inference.
export const VISUAL_CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    utilityProbability: { type: "number", minimum: 0, maximum: 1 },
    memeProbability: { type: "number", minimum: 0, maximum: 1 },
    brandingQuality: { type: "number", minimum: 0, maximum: 1 },
    professionalism: { type: "number", minimum: 0, maximum: 1 },
    visualSpamProbability: { type: "number", minimum: 0, maximum: 1 },
    requiresResearch: { type: "boolean" },
    reasoningSummary: { type: "array", items: { type: "string" }, maxItems: 8 },
  },
  required: [
    "utilityProbability",
    "memeProbability",
    "brandingQuality",
    "professionalism",
    "visualSpamProbability",
    "requiresResearch",
    "reasoningSummary",
  ],
} as const;

export const UTILITY_CLASSES = [
  "AI",
  "DEFI",
  "TRADING",
  "INFRASTRUCTURE",
  "DATA",
  "IDENTITY",
  "GAMING",
  "SOCIAL",
  "PAYMENTS",
  "RWA",
  "DEVELOPER_TOOLS",
  "SECURITY",
  "PRIVACY",
  "STORAGE",
  "COMPUTE",
  "DAO",
  "MARKETPLACE",
  "OTHER_UTILITY",
  "MEME",
  "UNKNOWN",
] as const;
export const UtilityClassEnum = z.enum(UTILITY_CLASSES);

const FactorScoreSchema = z.object({
  score: z.number().min(0).max(100),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  reasoning: z.string(),
});
export type FactorScore = z.infer<typeof FactorScoreSchema>;

const FACTOR_SCORE_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number", minimum: 0, maximum: 100 },
    confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    reasoning: { type: "string" },
  },
  required: ["score", "confidence", "reasoning"],
} as const;

export const ResearchSynthesisSchema = z.object({
  projectSummary: z.string(),
  utilityClass: UtilityClassEnum,
  productExists: z.boolean(),
  productPredatesToken: z.enum(["YES", "NO", "UNKNOWN"]),
  utility: FactorScoreSchema, // "Real Product / Utility" — 20% weight
  credibility: FactorScoreSchema, // project history / credibility — 10% weight
  website: FactorScoreSchema, // website / docs quality — 10% weight
  social: FactorScoreSchema, // social legitimacy — 10% weight
  team: FactorScoreSchema, // team / GitHub — 5% weight
  positives: z.array(z.string()).max(8),
  risks: z.array(z.string()).max(8),
  redFlags: z.array(z.string()).max(8),
  impersonationSuspected: z.boolean(),
});
export type ResearchSynthesis = z.infer<typeof ResearchSynthesisSchema>;

// §"position_monitor" strategy review (see trading/positionStrategy.ts) — a
// periodic/triggered check-in on an OPEN trade, not a new research pass. The
// AI proposes a strategy; deterministic code still enforces hard caps
// (re-entry size, re-entry count, circuit breakers, slippage) regardless of
// what's recommended here — this schema is advisory input, not an order.
export const PositionStrategyActionEnum = z.enum(["HOLD", "TAKE_PARTIAL_PROFIT", "EXIT_NOW", "SET_REENTRY_TARGET"]);

export const PositionStrategySchema = z.object({
  action: PositionStrategyActionEnum,
  // Only meaningful when action === "TAKE_PARTIAL_PROFIT".
  sellPercentOfRemaining: z.number().min(1).max(100).optional(),
  // Only meaningful when action === "SET_REENTRY_TARGET" — a level to watch
  // for, not an instruction to buy right now. The deterministic position
  // monitor executes automatically if/when price actually reaches it.
  reentryTargetMarketCapUsd: z.number().positive().optional(),
  reentrySizePercentOfOriginal: z.number().min(1).max(100).optional(),
  reentryValidForMinutes: z.number().min(5).max(720).optional(),
  reasoning: z.string(),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
});
export type PositionStrategyDecision = z.infer<typeof PositionStrategySchema>;

export const POSITION_STRATEGY_JSON_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["HOLD", "TAKE_PARTIAL_PROFIT", "EXIT_NOW", "SET_REENTRY_TARGET"] },
    sellPercentOfRemaining: { type: "number", minimum: 1, maximum: 100 },
    reentryTargetMarketCapUsd: { type: "number", exclusiveMinimum: 0 },
    reentrySizePercentOfOriginal: { type: "number", minimum: 1, maximum: 100 },
    reentryValidForMinutes: { type: "number", minimum: 5, maximum: 720 },
    reasoning: { type: "string" },
    confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
  },
  required: ["action", "reasoning", "confidence"],
} as const;

export const RESEARCH_SYNTHESIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    projectSummary: { type: "string" },
    utilityClass: { type: "string", enum: UTILITY_CLASSES },
    productExists: { type: "boolean" },
    productPredatesToken: { type: "string", enum: ["YES", "NO", "UNKNOWN"] },
    utility: FACTOR_SCORE_JSON_SCHEMA,
    credibility: FACTOR_SCORE_JSON_SCHEMA,
    website: FACTOR_SCORE_JSON_SCHEMA,
    social: FACTOR_SCORE_JSON_SCHEMA,
    team: FACTOR_SCORE_JSON_SCHEMA,
    positives: { type: "array", items: { type: "string" }, maxItems: 8 },
    risks: { type: "array", items: { type: "string" }, maxItems: 8 },
    redFlags: { type: "array", items: { type: "string" }, maxItems: 8 },
    impersonationSuspected: { type: "boolean" },
  },
  required: [
    "projectSummary",
    "utilityClass",
    "productExists",
    "productPredatesToken",
    "utility",
    "credibility",
    "website",
    "social",
    "team",
    "positives",
    "risks",
    "redFlags",
    "impersonationSuspected",
  ],
} as const;
