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
  // Direct on-chain pool-creation watching (onchainDiscovery.ts) — far tighter
  // than the DexScreener poll above since it reads chain state directly
  // instead of waiting on third-party indexing. ~100ms blocks means even a
  // handful of seconds covers many blocks per poll.
  onchainDiscoveryIntervalSeconds: num("ONCHAIN_DISCOVERY_INTERVAL_SECONDS", 3),
  // On-chain discovery is 6-7x the volume of the DexScreener feed and almost
  // entirely copycats/spam (confirmed live: 11 of 12 tokens sharing a single
  // trending name were bare on-chain clones with zero profile info) — every
  // one of those was still costing a paid AI classification call for nothing.
  // A token found on-chain now waits here, never touching AI, until
  // DexScreener's own profile feed confirms it's real; if that never happens
  // within this window it's dropped as noise instead of piling up forever.
  awaitingDexProfileExpiryHours: num("AWAITING_DEX_PROFILE_EXPIRY_HOURS", 24),
  // A cheaper, aggressive alternative to waiting on a submitted profile: real
  // trading activity (liquidity, transaction count) is public via DexScreener's
  // market/pair data regardless of whether a project ever bothers with a
  // profile — so a token showing genuine organic interest gets promoted to AI
  // review on that basis alone, without ever needing the profile signal.
  // Deliberately below MIN_LIQUIDITY_USD (the trade-eligibility gate) — this
  // only decides "worth an AI look", not "worth trading".
  awaitingProfileMinAgeMinutes: num("AWAITING_PROFILE_MIN_AGE_MINUTES", 20),
  awaitingProfileMinLiquidityUsd: num("AWAITING_PROFILE_MIN_LIQUIDITY_USD", 5000),
  awaitingProfileMinHourlyTxns: num("AWAITING_PROFILE_MIN_HOURLY_TXNS", 20),

  // X (Twitter) API v2, app-only auth — only the bearer token is needed for
  // read-only search/user-lookup. A real, metered cost (confirmed live: this
  // account returned 402 "credits depleted" on first test) — every call here
  // spends real money, so this is used sparingly and only for tokens that
  // already look promising, never as a blanket check on every discovery.
  xBearerToken: optStr("X_BEARER_TOKEN"),
  xSearchMaxPerSweep: num("X_SEARCH_MAX_PER_SWEEP", 3),
  // A mention existing isn't enough on its own — confirmed live that most
  // contract-address mentions on this chain come from automated calling/
  // scanner bots, not organic community. Real engagement (likes/retweets/
  // replies from *other* accounts) is what a bot's own posting volume can't
  // fake for free, so that's the actual promotion gate.
  xMinEngagementToPromote: num("X_MIN_ENGAGEMENT_TO_PROMOTE", 10),

  rhRpcUrl: str("RH_RPC_URL", "https://rpc.mainnet.chain.robinhood.com"),
  // Confirmed live: the primary RPC started returning a Cloudflare
  // bot-challenge page (HTTP 403, HTML body) for every request from
  // production specifically — not reproducible from other IPs, so almost
  // certainly a rate/reputation block on Railway's egress IP rather than a
  // real outage. This free public endpoint (verified: correctly answers
  // eth_chainId for 4663) is aggressively rate-limited (1 req/10s without an
  // API key from nodeflare.app) so it's a last-resort fallback, never the
  // primary — see wallet.ts's fallback transport, which only reaches this
  // after the primary itself fails.
  rhRpcFallbackUrl: str("RH_RPC_FALLBACK_URL", "https://rpc.nodeflare.app/robinhood/public"),
  rhExplorerApiUrl: optStr("RH_EXPLORER_API_URL"),

  geminiApiKey: optStr("GEMINI_API_KEY"),
  geminiApiKey2: optStr("GEMINI_API_KEY_2"),
  geminiApiKey3: optStr("GEMINI_API_KEY_3"),
  classifierModel: str("CLASSIFIER_MODEL", "gemini-flash-lite-latest"),
  // Defaults to the same lite model as classification: on a free-tier key,
  // "gemini-flash-latest" resolves to whatever the newest preview model is
  // (gemini-3.8-flash at time of writing), which carries a 20-requests/day
  // free quota — nowhere near enough for a 24/7 agent. Confirmed live.
  researchModel: str("RESEARCH_MODEL", "gemini-flash-lite-latest"),

  // SMTP relay for email alerts (replaces Resend, which hit its send cap).
  // Defaults target Gmail — free at up to 500 sends/24hr on a regular Gmail
  // account, 2000/24hr on Google Workspace; SMTP_USER/SMTP_PASS must be an
  // App Password (https://myaccount.google.com/apppasswords), not the login
  // password. Point at any other SMTP provider by overriding SMTP_HOST/PORT.
  smtpHost: str("SMTP_HOST", "smtp.gmail.com"),
  smtpPort: num("SMTP_PORT", 465),
  smtpUser: optStr("SMTP_USER"),
  smtpPass: optStr("SMTP_PASS"),
  alertEmailFrom: optStr("ALERT_EMAIL_FROM"),
  alertEmailTo: optStr("ALERT_EMAIL_TO"),

  minUtilityProbability: num("MIN_UTILITY_PROBABILITY", 0.65),
  maxMemeProbability: num("MAX_MEME_PROBABILITY", 0.45),
  minBrandingScore: num("MIN_BRANDING_SCORE", 0.35),

  // Deterministic bypass of the narrative utility/meme gate above (classify.ts):
  // real, already-observable trading demand (liquidity + genuine two-sided
  // transaction volume) is itself evidence worth researching further,
  // regardless of what the visual classifier's narrative verdict says. Added
  // after confirmed live misses — e.g. a token rejected as "doesn't align
  // with legitimate software/fintech" that went on to run 25K -> 137K mcap
  // with hundreds of real traders. Mirrors the same philosophy already used
  // for AWAITING_DEX_PROFILE promotion (awaitingProfileMin* below), applied
  // one stage later at the actual pass/fail decision.
  momentumOverrideMinLiquidityUsd: num("MOMENTUM_OVERRIDE_MIN_LIQUIDITY_USD", 15000),
  momentumOverrideMinHourlyTxns: num("MOMENTUM_OVERRIDE_MIN_HOURLY_TXNS", 20),

  watchlistThreshold: num("WATCHLIST_THRESHOLD", 70),
  alertThreshold: num("ALERT_THRESHOLD", 85),
  minConfidenceToAlert: num("MIN_CONFIDENCE_TO_ALERT", 55),

  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15000),
  minLiquidityToMcapRatio: num("MIN_LIQUIDITY_TO_MCAP_RATIO", 0.04),

  websiteTimeoutMs: num("WEBSITE_TIMEOUT_MS", 15000),
  researchTimeoutMs: num("RESEARCH_TIMEOUT_MS", 120000),

  researchCooldownHours: num("RESEARCH_COOLDOWN_HOURS", 6),

  // Railway (and most PaaS hosts) inject PORT and expect the app to bind to
  // it; API_PORT still wins if explicitly set, so local dev is unaffected.
  apiPort: num("API_PORT", num("PORT", 3000)),
  apiKey: optStr("API_KEY"),
};

export function assertRuntimeConfig() {
  const missing: string[] = [];
  if (!config.geminiApiKey) missing.push("GEMINI_API_KEY");
  if (!config.smtpUser) missing.push("SMTP_USER");
  if (!config.smtpPass) missing.push("SMTP_PASS");
  if (!config.alertEmailFrom) missing.push("ALERT_EMAIL_FROM");
  if (!config.alertEmailTo) missing.push("ALERT_EMAIL_TO");
  return missing;
}
