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

// Hand-written JSON Schema companion for the Claude tool call (see ai/provider.ts).
// zod-to-json-schema hits a TS type-instantiation-depth wall with this zod/TS
// combo, and there are only two schemas in this app, so keeping both in sync
// by hand is simpler than fighting the generic inference.
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
