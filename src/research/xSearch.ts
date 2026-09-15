import { config } from "../config";
import { logger } from "../logger";

/**
 * X (Twitter) API v2, app-only (bearer token) auth — read-only search and
 * the user data that comes bundled with it via `expansions=author_id`.
 *
 * Deliberately searches for the exact contract address, not the project
 * name: a scam can trivially clone a real project's name and branding, but
 * it cannot make genuine tweets about a *different* contract address exist
 * for its own copycat. A name-only search would have been fooled by exactly
 * the ORBIT FINANCE situation this was built for — the real account exists
 * and is legitimate, but a name search alone can't tell you it's talking
 * about a different token than the one in front of you.
 *
 * Note on account vetting: X's API does not expose a username-change
 * history for arbitrary accounts (no endpoint returns that, official or
 * otherwise) — this only surfaces what's actually available: account age,
 * follower/following/tweet counts, verified status, bio. Treat all of it as
 * informational context, not a hard pass/fail signal — a genuinely new
 * legitimate project's own announcement account is often only days old
 * with few followers too, so age/followers alone can't reliably separate
 * "new scam" from "new real project".
 */

const X_API_BASE = "https://api.twitter.com/2";
const REQUEST_TIMEOUT_MS = 10_000;

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
}

interface XUser {
  id: string;
  name: string;
  username: string;
  created_at?: string;
  description?: string;
  verified?: boolean;
  protected?: boolean;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
}

interface XSearchResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count: number };
  errors?: unknown;
  title?: string; // present on error responses (e.g. "Too Many Requests", "UsageCapExceeded")
}

export interface XAccountSummary {
  username: string;
  name: string;
  createdAt?: string;
  accountAgeDays?: number;
  followersCount?: number;
  followingCount?: number;
  tweetCount?: number;
  verified?: boolean;
  description?: string;
}

export interface XContractSearchResult {
  found: boolean;
  tweetCount: number;
  totalEngagement: number;
  /** found=true alone is weak: on this chain, most contract-address mentions
   * come from automated calling/scanner bots (confirmed live — accounts with
   * 5,000-30,000 tweets and generic "radar"/"scanner" bios showing up on
   * essentially every token, not organic community). hasGenuineSignal is the
   * one callers should actually gate on; it additionally requires real
   * engagement (likes/retweets/replies from *other* accounts), which a bot's
   * own posting volume can't fake for free. */
  hasGenuineSignal: boolean;
  sampleTweetUrls: string[];
  accounts: XAccountSummary[];
  error?: string;
}

export interface XNarrativeSearchResult {
  query: string;
  tweetCount: number;
  uniqueAccountCount: number;
  totalEngagement: number;
  credibleAccountCount: number;
  sampleTweetUrls: string[];
  accounts: XAccountSummary[];
  error?: string;
}

function accountAgeDays(createdAt: string | undefined): number | undefined {
  if (!createdAt) return undefined;
  return Math.round((Date.now() - new Date(createdAt).getTime()) / 86_400_000);
}

/**
 * Searches recent tweets (X's own 7-day window on this endpoint) for the
 * exact contract address as a quoted phrase. Costs one real, metered API
 * call — callers are responsible for not calling this on every token (see
 * discover.ts's promoteActiveAwaitingProfile, which bounds this to a handful
 * of already-promising candidates per sweep and checks each token at most
 * once via Token.xCheckedAt).
 */
export async function searchXForContractAddress(address: string): Promise<XContractSearchResult> {
  const empty: Omit<XContractSearchResult, "error"> = {
    found: false,
    tweetCount: 0,
    totalEngagement: 0,
    hasGenuineSignal: false,
    sampleTweetUrls: [],
    accounts: [],
  };
  if (!config.xBearerToken) {
    return { ...empty, error: "X_BEARER_TOKEN not configured" };
  }

  const query = `"${address}"`;
  const url =
    `${X_API_BASE}/tweets/search/recent` +
    `?query=${encodeURIComponent(query)}` +
    `&max_results=25` +
    `&tweet.fields=created_at,author_id,public_metrics` +
    `&expansions=author_id` +
    `&user.fields=created_at,public_metrics,verified,description,protected`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.xBearerToken}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ address, status: res.status, body: body.slice(0, 300) }, "X contract-address search failed");
      return { ...empty, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as XSearchResponse;
    const tweets = data.data ?? [];
    const users = data.includes?.users ?? [];

    const accounts: XAccountSummary[] = users.map((u) => ({
      username: u.username,
      name: u.name,
      createdAt: u.created_at,
      accountAgeDays: accountAgeDays(u.created_at),
      followersCount: u.public_metrics?.followers_count,
      followingCount: u.public_metrics?.following_count,
      tweetCount: u.public_metrics?.tweet_count,
      verified: u.verified,
      description: u.description,
    }));

    const totalEngagement = tweets.reduce((sum, t) => {
      const m = t.public_metrics;
      if (!m) return sum;
      return sum + m.like_count + m.retweet_count + m.reply_count + m.quote_count;
    }, 0);

    return {
      found: tweets.length > 0,
      tweetCount: tweets.length,
      totalEngagement,
      hasGenuineSignal: tweets.length > 0 && totalEngagement >= config.xMinEngagementToPromote,
      sampleTweetUrls: tweets.slice(0, 5).map((t) => `https://x.com/i/web/status/${t.id}`),
      accounts,
    };
  } catch (err) {
    logger.warn({ address, err: String(err) }, "X contract-address search threw");
    return { ...empty, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function searchXForNarrative(query: string, maxResults = 50): Promise<XNarrativeSearchResult> {
  const empty = {
    query,
    tweetCount: 0,
    uniqueAccountCount: 0,
    totalEngagement: 0,
    credibleAccountCount: 0,
    sampleTweetUrls: [],
    accounts: [],
  };
  if (!config.xBearerToken) {
    return { ...empty, error: "X_BEARER_TOKEN not configured" };
  }

  const url =
    `${X_API_BASE}/tweets/search/recent` +
    `?query=${encodeURIComponent(query)}` +
    `&max_results=${Math.max(10, Math.min(100, maxResults))}` +
    `&tweet.fields=created_at,author_id,public_metrics` +
    `&expansions=author_id` +
    `&user.fields=created_at,public_metrics,verified,description,protected`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.xBearerToken}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ query, status: res.status, body: body.slice(0, 300) }, "X narrative search failed");
      return { ...empty, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as XSearchResponse;
    const tweets = data.data ?? [];
    const users = data.includes?.users ?? [];
    const accounts: XAccountSummary[] = users.map((u) => ({
      username: u.username,
      name: u.name,
      createdAt: u.created_at,
      accountAgeDays: accountAgeDays(u.created_at),
      followersCount: u.public_metrics?.followers_count,
      followingCount: u.public_metrics?.following_count,
      tweetCount: u.public_metrics?.tweet_count,
      verified: u.verified,
      description: u.description,
    }));

    const totalEngagement = tweets.reduce((sum, t) => {
      const m = t.public_metrics;
      if (!m) return sum;
      return sum + m.like_count + m.retweet_count + m.reply_count + m.quote_count;
    }, 0);
    const credibleAccountCount = accounts.filter((a) => {
      const followers = a.followersCount ?? 0;
      const accountAge = a.accountAgeDays ?? 0;
      const tweetCount = a.tweetCount ?? 0;
      const looksLikeScanner = /scanner|radar|alert|call|gem|signal/i.test(a.description ?? "");
      return !looksLikeScanner && (a.verified || followers >= 500 || (followers >= 100 && accountAge >= 90 && tweetCount < 20_000));
    }).length;

    return {
      query,
      tweetCount: tweets.length,
      uniqueAccountCount: new Set(tweets.map((t) => t.author_id).filter(Boolean)).size || accounts.length,
      totalEngagement,
      credibleAccountCount,
      sampleTweetUrls: tweets.slice(0, 5).map((t) => `https://x.com/i/web/status/${t.id}`),
      accounts,
    };
  } catch (err) {
    logger.warn({ query, err: String(err) }, "X narrative search threw");
    return { ...empty, error: String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renders raw findings for the research AI to actually reason over, rather
 * than a pre-computed pass/fail — a hardcoded engagement cutoff can't tell a
 * quiet-but-real new project from a bought-engagement scam, but a model
 * weighing account age, follower/tweet-count ratios, bio content, and
 * engagement together, alongside everything else it already knows about
 * this token, can make that call far more meticulously.
 */
export function formatXFindingsForPrompt(xFindings: unknown): string {
  if (!xFindings) return "No X (Twitter) search was performed for this token.";
  const result = xFindings as XContractSearchResult;
  if (result.error) return `X search for this exact contract address failed (${result.error}) — treat as no data, not as a negative signal.`;
  if (!result.found) return "X search found zero tweets mentioning this exact contract address in the last 7 days.";

  const accountLines = result.accounts.map((a) => {
    const parts = [
      `@${a.username} ("${a.name}")`,
      a.accountAgeDays !== undefined ? `account age: ${a.accountAgeDays}d` : "account age: unknown",
      a.followersCount !== undefined ? `followers: ${a.followersCount}` : undefined,
      a.tweetCount !== undefined ? `total tweets ever: ${a.tweetCount}` : undefined,
      a.verified ? "verified" : undefined,
      a.description ? `bio: "${a.description}"` : undefined,
    ].filter(Boolean);
    return `- ${parts.join(", ")}`;
  });

  return [
    `Found ${result.tweetCount} tweet(s) in the last 7 days mentioning this exact contract address, with ${result.totalEngagement} combined likes/retweets/replies/quotes across them.`,
    `Note: on this chain, most contract-address mentions come from automated calling/scanner bots — an account with several thousand tweets and a generic "radar/scanner/alert" bio posting about many tokens is not evidence of a real project community. A small number of tweets from an account with a specific, on-topic bio is more meaningful than a high tweet count alone. Weigh account age, follower count relative to tweet count, bio content, and engagement together — do not treat "a tweet exists" by itself as validation.`,
    "Accounts that posted:",
    ...accountLines,
  ].join("\n");
}
