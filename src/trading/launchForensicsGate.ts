import "dotenv/config";
import { db } from "../db";
import { logger } from "../logger";
import type { ConvictionResult } from "./conservativeMode";
import { evaluateLaunchForensics, type LaunchForensics, type LaunchForensicsThresholds } from "./launchForensics";
import { getSolanaLaunchForensics, DEFAULT_SOLANA_FORENSICS_OPTIONS, type SolanaRpc } from "./solanaLaunchForensics";

/**
 * Launch forensics in production: read once per new candidate by a
 * background loop, stored as a LaunchForensicsSnapshot, and only looked up
 * at entry time. The entry never waits on RPC. No snapshot yet, a failed
 * read, or a spent budget all mean UNKNOWN, which never blocks.
 *
 * It runs on its own RPC endpoint, never the prod QuickNode key: that key
 * signs and confirms our trades and has a daily request cap, which a bulk
 * forensics study exhausted on 2026-09-25. The endpoint must keep full
 * history. PublicNode's free tier looks like a fit but silently returns
 * only the last ~2.7 days (checked 2026-09-25: zero signatures, no error,
 * for a bonding curve last used 9 days earlier), which would misplace the
 * launch of any older token. The public mainnet endpoint keeps everything,
 * rate-limited; a failed call just leaves the forensics UNKNOWN.
 */

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw === "true" || raw === "1";
}

export const launchForensicsSettings = {
  // On by default, report-only: every threshold below defaults to 0, so the
  // loop only stores snapshots for later study. Worker B's replay (2026-09-25)
  // found first-20 share >= 65% paid only on 09-16/17 and was flat after, so
  // nothing gates until live data shows an edge that holds.
  enabled: envBool("LAUNCH_FORENSICS_ENABLED", true),
  rpcUrl: process.env.FORENSICS_SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  /** For calls the main endpoint refuses (e.g. indexed lookups on a plan without them). */
  rpcFallbackUrl: process.env.FORENSICS_SOLANA_RPC_FALLBACK_URL || "https://api.mainnet-beta.solana.com",
  maxRpcCallsPerDay: envNum("FORENSICS_MAX_RPC_CALLS_PER_DAY", 5000),
  /** Don't start a read with less budget left than a typical read uses. */
  minBudgetToStart: envNum("FORENSICS_MIN_BUDGET_TO_START", 120),
  timeoutMs: envNum("LAUNCH_FORENSICS_TIMEOUT_MS", 120_000),
  pollSeconds: envNum("LAUNCH_FORENSICS_POLL_SECONDS", 10),
  /**
   * Requests per second to the forensics endpoint. The public endpoint
   * limits each method per IP, and Railway's egress IPs are shared: in the
   * first day live (2026-09-26), 23 of 26 reads failed on getTransaction 429s
   * when calls went out two at a time with quick retries.
   */
  rps: envNum("FORENSICS_RPC_RPS", 2),
  /** A rate-limited or timed-out read is retried this many times, spaced out, before it's recorded UNAVAILABLE. */
  maxAttempts: envNum("LAUNCH_FORENSICS_MAX_ATTEMPTS", 4),
  retryBaseSeconds: envNum("LAUNCH_FORENSICS_RETRY_BASE_SECONDS", 60),
  /** Candidates older than this are left alone. */
  lookbackMinutes: envNum("LAUNCH_FORENSICS_LOOKBACK_MINUTES", 180),
  thresholds: {
    maxFirst20BuyerSharePct: envNum("LAUNCH_FORENSICS_MAX_FIRST20_SHARE_PCT", 0),
    maxLaunchSlotBuySharePct: envNum("LAUNCH_FORENSICS_MAX_LAUNCH_BLOCK_SHARE_PCT", 0),
    maxCreatorSoldPctOfPeak: envNum("LAUNCH_FORENSICS_MAX_CREATOR_SOLD_PCT", 0),
    maxCreatorPriorDeadLaunches: envNum("LAUNCH_FORENSICS_MAX_PRIOR_DEAD_LAUNCHES", 0),
    maxLinkedBuyerSharePct: envNum("LAUNCH_FORENSICS_MAX_LINKED_SHARE_PCT", 0),
  } satisfies LaunchForensicsThresholds,
};

type Settings = typeof launchForensicsSettings;

export class ForensicsBudgetExhausted extends Error {
  constructor() {
    super("launch forensics daily RPC budget spent");
  }
}

/** RPC calls counted per UTC day, in-process. */
export class RpcBudget {
  private day = "";
  private used = 0;
  constructor(private readonly perDay: number, private readonly now: () => Date = () => new Date()) {}
  private roll(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
    }
  }
  remaining(): number {
    this.roll();
    return Math.max(0, this.perDay - this.used);
  }
  take(): void {
    this.roll();
    if (this.used >= this.perDay) throw new ForensicsBudgetExhausted();
    this.used++;
  }
}

/**
 * Every call spends budget; a spent budget fails the call instead of
 * sending it. The endpoint's own rate-limit retries inside
 * forensicsSolanaRpc count once, as the call they retry.
 */
export function withBudget(rpc: SolanaRpc, budget: RpcBudget): SolanaRpc & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    async call<T>(method: string, params: unknown[]): Promise<T> {
      budget.take();
      calls++;
      return rpc.call<T>(method, params);
    },
  };
}

// Errors that mean "this endpoint won't serve this", so the fallback gets it.
const WRONG_ENDPOINT = /403|personal token|not supported|cleaned up|-32601|Method not found/i;
const RETRYABLE = /429|Too many|unhealthy|timeout|timed out|ECONNRESET|fetch failed|50\d/i;

class RpcHttpError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

async function post<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new RpcHttpError(`${method}: HTTP ${res.status} ${text.slice(0, 120)}`, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
  }
  const body = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
  return body.result as T;
}

const RATE_LIMIT_RETRIES = 4;

/**
 * The forensics endpoint and its fallback for calls it won't serve. Calls
 * are paced to `rps`, one at a time, and a rate limit is waited out (2, 4,
 * 8, 16s, or the server's Retry-After) rather than retried at once.
 */
export function forensicsSolanaRpc(settings: Pick<Settings, "rpcUrl" | "rpcFallbackUrl" | "rps"> = launchForensicsSettings): SolanaRpc {
  let nextSendAt = 0;
  const pace = async () => {
    const now = Date.now();
    const wait = Math.max(0, nextSendAt - now);
    nextSendAt = Math.max(now, nextSendAt) + 1000 / Math.max(0.1, settings.rps);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      let url = settings.rpcUrl;
      for (let attempt = 0; ; attempt++) {
        await pace();
        try {
          return await post<T>(url, method, params);
        } catch (err) {
          const msg = String(err);
          if (url !== settings.rpcFallbackUrl && WRONG_ENDPOINT.test(msg)) {
            url = settings.rpcFallbackUrl;
            continue;
          }
          if (attempt >= RATE_LIMIT_RETRIES || !RETRYABLE.test(msg)) throw err;
          const backoff = err instanceof RpcHttpError && err.retryAfterMs ? err.retryAfterMs : 2000 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    },
  };
}

/** Candidates whose read hit a rate limit or timeout: how often, and when to try again. */
const retryState = new Map<string, { attempts: number; nextAt: number }>();

function toJson(f: LaunchForensics): object {
  return JSON.parse(JSON.stringify(f, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export interface ForensicsDeps {
  settings?: Settings;
  budget?: RpcBudget;
  rpc?: SolanaRpc;
  read?: typeof getSolanaLaunchForensics;
  retries?: Map<string, { attempts: number; nextAt: number }>;
  now?: () => number;
}

export type ForensicsTickOutcome = "none" | "budget" | "ready" | "unavailable" | "deferred";

const defaultBudget = new RpcBudget(launchForensicsSettings.maxRpcCallsPerDay);
let defaultRpc: SolanaRpc | undefined;

/**
 * Read forensics for the newest Solana candidate that doesn't have them yet.
 * Returns what it did, for the loop's logging and tests.
 */
export async function computeNextLaunchForensics(deps: ForensicsDeps = {}): Promise<ForensicsTickOutcome> {
  const settings = deps.settings ?? launchForensicsSettings;
  const budget = deps.budget ?? defaultBudget;
  const retries = deps.retries ?? retryState;
  const now = (deps.now ?? Date.now)();
  if (budget.remaining() < settings.minBudgetToStart) return "budget";

  const since = new Date(now - settings.lookbackMinutes * 60_000);
  const recent = await db.tradeCandidate.findMany({
    where: { createdAt: { gte: since }, token: { chain: "solana" } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, token: { select: { address: true } } },
  });
  if (recent.length === 0) return "none";
  const done = new Set((await db.launchForensicsSnapshot.findMany({ where: { candidateId: { in: recent.map((c) => c.id) } }, select: { candidateId: true } })).map((s) => s.candidateId));
  const next = recent.find((c) => !done.has(c.id) && (retries.get(c.id)?.nextAt ?? 0) <= now);
  if (!next) return "none";

  const rpc = withBudget(deps.rpc ?? (defaultRpc ??= forensicsSolanaRpc(settings)), budget);
  const t = settings.thresholds;
  const opts = {
    ...DEFAULT_SOLANA_FORENSICS_OPTIONS,
    concurrency: 1,
    // Funding links cost ~40-60 calls a read; only pay for them when they gate.
    includeFunding: t.maxLinkedBuyerSharePct > 0,
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const forensics = await Promise.race([
      (deps.read ?? getSolanaLaunchForensics)(next.token.address, undefined, rpc, opts),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${settings.timeoutMs}ms`)), settings.timeoutMs);
      }),
    ]);
    await db.launchForensicsSnapshot.create({
      data: { candidateId: next.id, chain: "solana", token: next.token.address, status: "READY", features: toJson(forensics), rpcCalls: rpc.calls() },
    });
    retries.delete(next.id);
    logger.info({ candidateId: next.id, token: next.token.address, rpcCalls: rpc.calls(), budgetLeft: budget.remaining(), unknowns: forensics.unknowns }, "launch forensics read");
    return "ready";
  } catch (err) {
    // A spent budget leaves no row, so the candidate is retried tomorrow if
    // it's still in the lookback window.
    if (err instanceof ForensicsBudgetExhausted) return "budget";
    // A rate limit or timeout is the endpoint's state, not the token's: try
    // again later, further apart each time, before giving up on it.
    const attempts = (retries.get(next.id)?.attempts ?? 0) + 1;
    if (RETRYABLE.test(String(err)) && attempts < settings.maxAttempts) {
      retries.set(next.id, { attempts, nextAt: now + settings.retryBaseSeconds * 1000 * 2 ** (attempts - 1) });
      logger.info({ candidateId: next.id, attempts, err: String(err).slice(0, 160) }, "launch forensics read rate-limited — retrying later");
      return "deferred";
    }
    retries.delete(next.id);
    await db.launchForensicsSnapshot.create({
      data: { candidateId: next.id, chain: "solana", token: next.token.address, status: "UNAVAILABLE", error: `after ${attempts} attempt(s): ${String(err)}`.slice(0, 500), rpcCalls: rpc.calls() },
    });
    logger.warn({ candidateId: next.id, attempts, err: String(err) }, "launch forensics unavailable — UNKNOWN, never blocks");
    return "unavailable";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function launchForensicsLoop(signal: { stopped: boolean }, deps: ForensicsDeps = {}): Promise<void> {
  const settings = deps.settings ?? launchForensicsSettings;
  if (!settings.enabled) return;
  logger.info({ rpc: new URL(settings.rpcUrl).host, maxRpcCallsPerDay: settings.maxRpcCallsPerDay }, "launch forensics loop started");
  while (!signal.stopped) {
    let outcome: ForensicsTickOutcome = "none";
    try {
      outcome = await computeNextLaunchForensics(deps);
    } catch (err) {
      logger.error({ err: String(err) }, "launch forensics tick failed");
    }
    // Straight on to the next candidate after a read. After a rate limit,
    // give the endpoint a real rest before touching it again.
    if (outcome === "deferred") await new Promise((r) => setTimeout(r, settings.retryBaseSeconds * 1000));
    else if (outcome !== "ready" && outcome !== "unavailable") await new Promise((r) => setTimeout(r, settings.pollSeconds * 1000));
  }
}

/**
 * The entry check: the stored forensics against today's thresholds (so a
 * threshold change applies without re-reading). Passes when there's nothing
 * stored, the read failed, no threshold is on, or the lookup itself fails.
 */
export async function launchForensicsVerdict(candidateId: string, settings: Settings = launchForensicsSettings): Promise<ConvictionResult> {
  const pass: ConvictionResult = { passed: true, failedChecks: [], reasons: [] };
  if (!settings.enabled || Object.values(settings.thresholds).every((t) => t <= 0)) return pass;
  const snapshot = await db.launchForensicsSnapshot.findUnique({ where: { candidateId } }).catch((err) => {
    logger.warn({ candidateId, err: String(err) }, "launch forensics lookup failed — UNKNOWN, not blocking");
    return null;
  });
  if (!snapshot || snapshot.status !== "READY" || !snapshot.features) return pass;
  const verdict = evaluateLaunchForensics(snapshot.features as unknown as LaunchForensics, settings.thresholds);
  return { passed: verdict.passed, failedChecks: verdict.failedChecks.map((c) => `forensics:${c}`), reasons: verdict.reasons.map((r) => `launch forensics: ${r}`) };
}
