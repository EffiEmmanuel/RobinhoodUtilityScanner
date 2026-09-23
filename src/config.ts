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

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  if (["1", "true", "yes", "on"].includes(v.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(v.toLowerCase())) return false;
  throw new Error(`Env var ${name} must be a boolean, got "${v}"`);
}

function csv(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  return v
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export const config = {
  nodeEnv: str("NODE_ENV", "development"),
  logLevel: str("LOG_LEVEL", "info"),

  dexscreenerBaseUrl: str("DEXSCREENER_BASE_URL", "https://api.dexscreener.com"),
  targetChainId: str("TARGET_CHAIN_ID", "robinhood"),
  // Chains DexScreener-poll discovery and narrative generation should look
  // at. Deliberately separate from targetChainId (which every EVM-only
  // module below still keys off) rather than a rename/repurpose of it — most
  // existing call sites (onchainDiscovery.ts, manualSubmit.ts, poller.ts)
  // write/read a single EVM chain id and have no Solana counterpart yet, so
  // changing what targetChainId means there would be a behavior change, not
  // a no-op. This is additive: defaults to just [targetChainId].
  enabledChains: csv("ENABLED_CHAINS", [str("TARGET_CHAIN_ID", "robinhood")]),
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
  // User directive 2026-09-22: "we should never invest in shitcoins with no
  // dex banner, link(s) and all of that" — the activity-only and X-mention-
  // only promotion paths just above/below this both let a token reach AI
  // review, and eventually a live trade, with zero icon/header/website/
  // social presence, purely on raw volume or a tweet mentioning the contract
  // address. When true, discover.ts's promoteActiveAwaitingProfile only ever
  // promotes on hasRealProfile — activity and X evidence can still queue an
  // X check (still useful signal for research), but neither can promote a
  // token past this gate on its own anymore. Default false so a fresh
  // checkout's behavior is unchanged; tightened live via Railway env, not
  // the code default, same pattern as every other gate this session.
  requireDexProfileToPromote: bool("REQUIRE_DEX_PROFILE_TO_PROMOTE", false),

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
  rhRpcExtraUrls: csv("RH_RPC_EXTRA_URLS"),
  rhExplorerApiUrl: optStr("RH_EXPLORER_API_URL"),

  // Reserved for the Solana discovery/risk/execution work (unused until those
  // land) — kept alongside the EVM config above rather than mixed into it,
  // since none of this is read yet. SOLANA_WALLET_PRIVATE_KEY intentionally
  // isn't here: BOT_WALLET_PRIVATE_KEY (wallet.ts) isn't part of this object
  // either, so secrets never end up in a loggable config dump.
  solanaRpcUrl: optStr("SOLANA_RPC_URL"),
  solanaRpcFallbackUrl: optStr("SOLANA_RPC_FALLBACK_URL"),
  solanaRpcExtraUrls: csv("SOLANA_RPC_EXTRA_URLS"),
  solanaExplorerApiUrl: optStr("SOLANA_EXPLORER_API_URL"),
  // Drives solanaOnchainDiscoveryLoop (pipeline/solanaOnchainDiscovery.ts) —
  // unlike onchainDiscoveryIntervalSeconds this isn't a poll cadence that
  // directly gates freshness (discovery itself is event-driven, via a
  // persistent pump.fun log subscription); this only governs how often the
  // loop checks the subscription is still alive and reports health, and
  // becomes the backoff base if it isn't.
  solanaDiscoveryIntervalSeconds: num("SOLANA_DISCOVERY_INTERVAL_SECONDS", 15),
  // Verified current and correct against Jupiter's live API docs/swagger
  // spec as of 2026-09-16 (GET /quote, POST /swap, both under this base) —
  // lite-api.jup.ag is the free no-API-key tier; api.jup.ag is the paid tier
  // requiring an x-api-key header. Jupiter's hosted API has moved hosts/tiers
  // before (quote-api.jup.ag -> lite-api.jup.ag), so this stays configurable
  // rather than hardcoded in case it moves again — re-verify if a long time
  // has passed since the date above.
  solanaJupiterBaseUrl: str("SOLANA_JUPITER_BASE_URL", "https://lite-api.jup.ag/swap/v1"),
  // User-supplied 2026-09-22, after confirming live that lite-api.jup.ag's
  // free tier was HTTP 429-rate-limiting real quote/swap calls (both
  // directions) for manual buy-and-hold entries — sent as the x-api-key
  // header on every Jupiter call once set (jupiterClient.ts). The user's own
  // plan on this key is capped at 1 request/second — see
  // JUPITER_MIN_REQUEST_INTERVAL_MS in util/http.ts's minIntervalMs, which
  // throttles every jup.ag call (with or without a key) to stay under that.
  jupiterApiKey: optStr("JUPITER_API_KEY"),
  // Hard off by default and independent of TRADING_MODE (which today only
  // governs the EVM path) — flipping EVM to LIVE must never silently also
  // enable live Solana trading. See live/solana/wallet.ts's doc comment:
  // the shared circuit-breaker/capital ledger doesn't account for Solana
  // positions yet, so this is a deliberately separate, narrower gate.
  solanaTradingEnabled: bool("SOLANA_TRADING_ENABLED", false),

  // Arc: Circle's new EVM L1 (chain id 5042), public mainnet launched
  // 2026-09-16. Ships as observation-only, not a real second trading chain —
  // deliberately does NOT go through ENABLED_CHAINS/discover.ts, because that
  // path ends at honeypotCheck.ts's hard fail-closed reject for any chain
  // that isn't targetChainId or "solana" (see honeypotCheck.ts:97): every Arc
  // token would be discovered, scored, then permanently killed there. Day-one
  // launchpad volume (Tolly/ArcPad/Flipt) is also confirmed closed-test-
  // environment activity, not proven organic demand, so this only alerts on
  // real trading activity via arcObserve.ts — never creates a Token row,
  // never runs honeypot/research, never becomes a trade candidate. Off by
  // default; flip ARC_OBSERVATION_ENABLED once you want visibility.
  arcObservationEnabled: bool("ARC_OBSERVATION_ENABLED", false),
  arcObservationIntervalSeconds: num("ARC_OBSERVATION_INTERVAL_SECONDS", 60),
  arcObservationMinLiquidityUsd: num("ARC_OBSERVATION_MIN_LIQUIDITY_USD", 10000),
  arcObservationMinVolume1hUsd: num("ARC_OBSERVATION_MIN_VOLUME_1H_USD", 5000),
  // How long a candidate is re-checked for real activity before being given
  // up on — mirrors awaitingDexProfileExpiryHours's bounded-retry idea, kept
  // in-memory only since this never touches the DB.
  arcObservationCandidateExpiryHours: num("ARC_OBSERVATION_CANDIDATE_EXPIRY_HOURS", 12),

  walletTrackingEnabled: bool("WALLET_TRACKING_ENABLED", true),
  walletTrackingIntervalSeconds: num("WALLET_TRACKING_INTERVAL_SECONDS", 15),
  // Robinhood Chain is fast, and public RPCs often cap eth_getLogs ranges.
  // Keep wallet scans incremental and bounded; lag catches up over several
  // ticks instead of risking one giant provider-rejected request.
  walletTrackingBatchBlocks: num("WALLET_TRACKING_BATCH_BLOCKS", 500),
  walletTrackingInitialBackfillBlocks: num("WALLET_TRACKING_INITIAL_BACKFILL_BLOCKS", 3000),

  geminiApiKey: optStr("GEMINI_API_KEY"),
  // Unbounded rotation pool: GEMINI_API_KEY, GEMINI_API_KEY_2, _3, _4, ... —
  // each one ideally a separate Google account/project so it carries its own
  // independent free-tier daily quota (see provider.ts). Stops at the first
  // gap so keys must be numbered contiguously from 2, but there's no cap on
  // how many can be added; growing the pool is a Railway env var, not a
  // code change.
  geminiApiKeys: (() => {
    const keys = [optStr("GEMINI_API_KEY")].filter((k): k is string => Boolean(k));
    for (let i = 2; ; i++) {
      const key = optStr(`GEMINI_API_KEY_${i}`);
      if (!key) break;
      keys.push(key);
    }
    return keys;
  })(),
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
  // Confirmed live 2026-09-17: raw SMTP to smtp.gmail.com:465 from Railway
  // started timing out on 100% of sends (0 successes, 26/26 failures over
  // ~3.6h) — same class of infra fragility as the 2026-09-16 IPv6 dead-end
  // fix in mailer.ts, just a harder failure this time (likely Railway or
  // Google blocking outbound SMTP from shared cloud-host IP ranges, a common
  // anti-abuse pattern neither side documents). When set, mailer.ts sends via
  // Brevo's HTTPS API instead of raw SMTP — port 443 doesn't have this
  // problem. Free tier: 300 emails/day, https://app.brevo.com (Settings ->
  // SMTP & API -> API Keys). SMTP_USER/SMTP_PASS above stay as a fallback
  // when this isn't set.
  brevoApiKey: optStr("BREVO_API_KEY"),

  minUtilityProbability: num("MIN_UTILITY_PROBABILITY", 0.65),
  maxMemeProbability: num("MAX_MEME_PROBABILITY", 0.45),
  minBrandingScore: num("MIN_BRANDING_SCORE", 0.35),

  // Retired as a utility/meme gate bypass (user directive 2026-09-18) — real
  // trading volume no longer overrides a meme verdict anywhere in the
  // pipeline. Kept only for planning.ts's isExtremeMomentum, an entry-timing
  // signal (chase vs. wait for pullback) for candidates that have ALREADY
  // cleared the utility gate — unrelated to whether a token is meme or not.
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
  // Either transport works (see mailer.ts) — only flag SMTP as missing when
  // Brevo isn't configured as the alternative.
  if (!config.brevoApiKey) {
    if (!config.smtpUser) missing.push("SMTP_USER");
    if (!config.smtpPass) missing.push("SMTP_PASS");
  }
  if (!config.alertEmailFrom) missing.push("ALERT_EMAIL_FROM");
  if (!config.alertEmailTo) missing.push("ALERT_EMAIL_TO");
  return missing;
}
