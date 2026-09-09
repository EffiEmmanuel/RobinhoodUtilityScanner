import { z } from "zod";

export const MARKET_REGIMES = [
  "EARLY_DISCOVERY",
  "BREAKOUT",
  "PULLBACK",
  "RETEST",
  "CONSOLIDATION",
  "TRENDING_UP",
  "TRENDING_DOWN",
  "PARABOLIC",
  "DISTRIBUTION",
  "LOW_LIQUIDITY",
  "CHOPPY",
  "UNKNOWN",
] as const;

export const TRADE_PLAN_ACTIONS = ["BUY_NOW", "WAIT_FOR_ENTRY", "WATCH_ONLY", "REJECT_TRADE"] as const;

// §83 — AI proposes market interpretation + a recommended action; it never
// determines position size or bypasses deterministic risk rules (src/trading/
// riskEngine.ts owns those, always applied after this call, never before).
export const TradeAnalysisSchema = z.object({
  marketRegime: z.enum(MARKET_REGIMES),
  isExtended: z.boolean(), // is price meaningfully above recent support/swing low right now?
  recommendedAction: z.enum(TRADE_PLAN_ACTIONS),
  entryStyle: z.enum(["MARKET_ENTRY", "PULLBACK_ENTRY", "BREAKOUT_RETEST_ENTRY"]).optional(),
  targetEntryMcapMin: z.number().optional(),
  targetEntryMcapMax: z.number().optional(),
  doNotChaseAboveMcap: z.number().optional(),
  technicalInvalidationMcap: z.number().optional(),
  riskScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  reasoning: z.array(z.string()).max(10),
});
export type TradeAnalysis = z.infer<typeof TradeAnalysisSchema>;

export const TRADE_ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    marketRegime: { type: "string", enum: MARKET_REGIMES },
    isExtended: { type: "boolean" },
    recommendedAction: { type: "string", enum: TRADE_PLAN_ACTIONS },
    entryStyle: { type: "string", enum: ["MARKET_ENTRY", "PULLBACK_ENTRY", "BREAKOUT_RETEST_ENTRY"] },
    targetEntryMcapMin: { type: "number" },
    targetEntryMcapMax: { type: "number" },
    doNotChaseAboveMcap: { type: "number" },
    technicalInvalidationMcap: { type: "number" },
    riskScore: { type: "number", minimum: 0, maximum: 100 },
    confidence: { type: "number", minimum: 0, maximum: 100 },
    reasoning: { type: "array", items: { type: "string" }, maxItems: 10 },
  },
  required: ["marketRegime", "isExtended", "recommendedAction", "riskScore", "confidence", "reasoning"],
} as const;

// §72 — AI postmortem. Lessons are stored, never fed back to auto-alter a
// production strategy (see src/trading/strategy.ts — promotion is manual only).
export const PostmortemAnalysisSchema = z.object({
  result: z.enum(["WIN", "LOSS", "BREAKEVEN"]),
  entryQuality: z.number().min(0).max(100),
  exitQuality: z.number().min(0).max(100),
  whatWorked: z.array(z.string()).max(6),
  whatFailed: z.array(z.string()).max(6),
  missedOpportunity: z.string().optional(),
  lessons: z.array(z.string()).max(6),
  summary: z.string(),
});
export type PostmortemAnalysis = z.infer<typeof PostmortemAnalysisSchema>;

export const POSTMORTEM_JSON_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string", enum: ["WIN", "LOSS", "BREAKEVEN"] },
    entryQuality: { type: "number", minimum: 0, maximum: 100 },
    exitQuality: { type: "number", minimum: 0, maximum: 100 },
    whatWorked: { type: "array", items: { type: "string" }, maxItems: 6 },
    whatFailed: { type: "array", items: { type: "string" }, maxItems: 6 },
    missedOpportunity: { type: "string" },
    lessons: { type: "array", items: { type: "string" }, maxItems: 6 },
    summary: { type: "string" },
  },
  required: ["result", "entryQuality", "exitQuality", "whatWorked", "whatFailed", "lessons", "summary"],
} as const;
