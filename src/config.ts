import "dotenv/config";

function str(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

export const config = {
  nodeEnv: str("NODE_ENV", "development"),
  logLevel: str("LOG_LEVEL", "info"),

  dexscreenerBaseUrl: str("DEXSCREENER_BASE_URL", "https://api.dexscreener.com"),
  targetChainId: str("TARGET_CHAIN_ID", "robinhood"),
  discoveryIntervalSeconds: num("DISCOVERY_INTERVAL_SECONDS", 15),

  rhRpcUrl: str("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  rhExplorerApiUrl: optStr("RH_EXPLORER_API_URL"),

  anthropicApiKey: optStr("ANTHROPIC_API_KEY"),
  classifierModel: str("CLASSIFIER_MODEL", "claude-haiku-4-5-20251001"),
  researchModel: str("RESEARCH_MODEL", "claude-sonnet-5"),

  resendApiKey: optStr("RESEND_API_KEY"),
  alertEmailFrom: optStr("ALERT_EMAIL_FROM"),
  alertEmailTo: optStr("ALERT_EMAIL_TO"),

  minUtilityProbability: num("MIN_UTILITY_PROBABILITY", 0.65),
  maxMemeProbability: num("MAX_MEME_PROBABILITY", 0.45),
  minBrandingScore: num("MIN_BRANDING_SCORE", 0.35),

  watchlistThreshold: num("WATCHLIST_THRESHOLD", 70),
  alertThreshold: num("ALERT_THRESHOLD", 85),
  minConfidenceToAlert: num("MIN_CONFIDENCE_TO_ALERT", 55),

  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15000),
  minLiquidityToMcapRatio: num("MIN_LIQUIDITY_TO_MCAP_RATIO", 0.04),

  websiteTimeoutMs: num("WEBSITE_TIMEOUT_MS", 15000),
  researchTimeoutMs: num("RESEARCH_TIMEOUT_MS", 120000),

  researchCooldownHours: num("RESEARCH_COOLDOWN_HOURS", 6),

  apiPort: num("API_PORT", 3000),
  apiKey: optStr("API_KEY"),
};

export function assertRuntimeConfig() {
  const missing: string[] = [];
  if (!config.anthropicApiKey) missing.push("ANTHROPIC_API_KEY");
  if (!config.resendApiKey) missing.push("RESEND_API_KEY");
  if (!config.alertEmailFrom) missing.push("ALERT_EMAIL_FROM");
  if (!config.alertEmailTo) missing.push("ALERT_EMAIL_TO");
  return missing;
}
