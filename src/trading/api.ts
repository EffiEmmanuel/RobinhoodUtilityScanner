import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { rawQuery } from "../rawDb";
import { tradingConfig } from "./config";
import { isTradingEnabled, setTradingEnabled } from "./runtimeState";
import { getPortfolioState, checkCircuitBreakers, resetCircuitBreakerCounters, getTotalRealizedPnlUsd } from "./portfolio";
import { promoteStrategyVersion } from "./strategy";
import { isWalletConfigured, getWalletAddress } from "./live/wallet";
import { isLiveModeReady, getWalletGasBalanceEth } from "./live/liveExecutionProvider";
import { getAllowedRouterAddresses } from "./live/contracts";
import { runBacktest, runEntryBacktest } from "./backtest";
import { trainOrAnalyze, exportFeatureDataset, computeOutcomeRateByTradeLane, computeOutcomeRateByQualificationPath, type OutcomeLabel } from "./learning";
import { getActiveStrategyVersion } from "./strategy";
import { PendingEntryStatus, StrategyStatus, TradeCandidateStatus, TradeStatus, TradeDecision } from "../generated/prisma";

function startOfLocalDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function reasonText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join("; ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return String(value ?? "");
}

function classifyNoTradeReason(text: string): string {
  const r = text.toLowerCase();
  if (/honeypot|wallet cannot transfer|no sell path|sell quote|blacklist|bot-control|transfer.*blocked/.test(r)) return "honeypot/transfer safety";
  if (/utility|product|meme|unknown tokens|website|credibility|token-first/.test(r)) return "utility/product gate";
  if (/contractscore|contract score|contract safety|owner|tax|trading control|transfer limit/.test(r)) return "contract safety";
  if (/liquidity|mcap|market cap/.test(r)) return "liquidity/market-cap";
  if (/qualityscore|researchconfidence|confidence/.test(r)) return "quality/confidence";
  if (/parabolic|chase|run-up|price velocity|buy ratio|sell pressure|volume/.test(r)) return "market timing";
  if (/circuit|deployable|capital|gas|open positions|kill switch/.test(r)) return "portfolio/circuit breaker";
  if (/watch|wait|risk|skip|ai strategy|planning/.test(r)) return "planning/risk";
  return "other";
}

/** Registers the trading extension's read/control endpoints onto the
 * existing API server (§78). No execution-trigger endpoints exist here —
 * there is nothing for a human or script to "fire" since everything is
 * either autonomous (paper) or read-only. Wallet address is safe to expose
 * (that's the whole point of an address); the private key is never
 * reachable from any module this file imports. */
export function registerTradingRoutes(app: FastifyInstance): void {
  app.get("/trading/status", async () => {
    const [portfolio, circuitBreakers, realizedPnlUsd] = await Promise.all([
      getPortfolioState(),
      checkCircuitBreakers(),
      getTotalRealizedPnlUsd(),
    ]);
    // User directive 2026-09-12: the dashboard's account-health stat card.
    // unrealizedPnlUsd is derived the same way recordPortfolioSnapshot
    // already does (open positions' current value vs. what they cost),
    // not stored separately — no new query needed, portfolio has both figures.
    const unrealizedPnlUsd = portfolio.openPositionValueUsd - portfolio.deployedUsd;
    const totalPnlUsd = realizedPnlUsd + unrealizedPnlUsd;
    const walletConfigured = isWalletConfigured();
    return {
      mode: tradingConfig.mode,
      tradingEnabled: isTradingEnabled(),
      circuitBreakers,
      portfolio: { ...portfolio, realizedPnlUsd, unrealizedPnlUsd, totalPnlUsd },
      live: {
        walletConfigured,
        walletAddress: walletConfigured ? getWalletAddress() : null,
        walletGasBalanceEth: walletConfigured ? await getWalletGasBalanceEth().catch(() => null) : null,
        ready: isLiveModeReady(),
        allowedRouterAddresses: getAllowedRouterAddresses(),
      },
    };
  });

  app.post("/trading/pause", async () => {
    setTradingEnabled(false);
    return { tradingEnabled: false };
  });

  app.post("/trading/resume", async () => {
    setTradingEnabled(true);
    return { tradingEnabled: true };
  });

  // User directive 2026-09-12: a manual "start the loss breakers fresh from
  // right now" trigger — the daily-loss and consecutive-loss checks stop
  // counting anything before this call. Real trade/ledger history is
  // untouched; this only moves what those two breakers are willing to count
  // from (see portfolio.ts's CircuitBreakerReset). The other breakers (kill
  // switch, gas, max open positions) are unaffected — this can't be used to
  // bypass those.
  app.post("/trading/reset-circuit-breaker", async (req) => {
    const { reason } = (req.body as { reason?: string } | undefined) ?? {};
    await resetCircuitBreakerCounters(reason);
    return checkCircuitBreakers();
  });

  app.get("/trading/no-trade-diagnostics", async (req) => {
    const { hours, limit } = req.query as { hours?: string; limit?: string };
    const lookbackHours = Math.min(Math.max(Number(hours) || 24, 1), 168);
    const take = Math.min(Number(limit) || 60, 150);
    const since = new Date(Date.now() - lookbackHours * 3_600_000);
    const today = startOfLocalDay();

    type CandidateGroupRow = {
      status: TradeCandidateStatus;
      tradeLane: string | null;
      qualificationPath: string | null;
      count: number;
    };
    type RecentCandidateRow = {
      id: string;
      status: TradeCandidateStatus;
      tradeLane: string | null;
      qualificationPath: string | null;
      qualityScore: number | null;
      researchConfidence: number | null;
      createdAt: Date;
      token: string;
      stage: string | null;
      decision: TradeDecision | null;
      finalReasons: unknown;
      decisionCreatedAt: Date | null;
    };

    const [candidateGroups, recentCandidates, activePendingEntries, openPositions, tradesToday, latestTrade, circuitBreakers, activeStrategy] =
      await Promise.all([
        rawQuery<CandidateGroupRow>(
          `
          SELECT status,
                 "tradeLane",
                 "qualificationPath",
                 COUNT(*)::int AS count
          FROM "TradeCandidate"
          WHERE "createdAt" >= $1
          GROUP BY status, "tradeLane", "qualificationPath"
        `,
          [since]
        ),
        rawQuery<RecentCandidateRow>(
          `
          SELECT tc.id,
                 tc.status,
                 tc."tradeLane",
                 tc."qualificationPath",
                 tc."qualityScore",
                 tc."researchConfidence",
                 tc."createdAt",
                 COALESCE(t.symbol, t.name, SUBSTRING(t.address, 1, 8)) AS token,
                 d.stage,
                 d.decision,
                 d."finalReasons",
                 d."createdAt" AS "decisionCreatedAt"
          FROM "TradeCandidate" tc
          JOIN "Token" t ON t.id = tc."tokenId"
          LEFT JOIN LATERAL (
            SELECT stage, decision, "finalReasons", "createdAt"
            FROM "TradeDecisionSnapshot" d
            WHERE d."candidateId" = tc.id
            ORDER BY d."createdAt" DESC
            LIMIT 1
          ) d ON true
          WHERE tc."createdAt" >= $1
          ORDER BY tc."createdAt" DESC
          LIMIT $2
        `,
          [since, take]
        ),
        db.pendingEntry.count({ where: { status: PendingEntryStatus.ACTIVE } }),
        db.trade.count({ where: { status: { in: [TradeStatus.OPEN, TradeStatus.PARTIALLY_EXITED] } } }),
        db.trade.findMany({
          where: { OR: [{ createdAt: { gte: today } }, { openedAt: { gte: today } }, { closedAt: { gte: today } }] },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: {
            status: true,
            createdAt: true,
            openedAt: true,
            closedAt: true,
            realizedPnlUsd: true,
            realizedMultiple: true,
            exitReason: true,
            token: { select: { symbol: true, name: true, address: true } },
          },
        }),
        db.trade.findFirst({
          orderBy: { createdAt: "desc" },
          select: {
            status: true,
            createdAt: true,
            openedAt: true,
            closedAt: true,
            realizedPnlUsd: true,
            realizedMultiple: true,
            exitReason: true,
            token: { select: { symbol: true, name: true, address: true } },
          },
        }),
        checkCircuitBreakers(),
        getActiveStrategyVersion(),
      ]);

    const reasonBuckets = new Map<string, { count: number; examples: string[] }>();
    const recent = recentCandidates.map((candidate) => {
      const text = reasonText(candidate.finalReasons);
      const category = classifyNoTradeReason(text);
      if (text) {
        const bucket = reasonBuckets.get(category) ?? { count: 0, examples: [] };
        bucket.count++;
        if (bucket.examples.length < 4) bucket.examples.push(text.slice(0, 220));
        reasonBuckets.set(category, bucket);
      }
      return {
        id: candidate.id,
        token: candidate.token,
        status: candidate.status,
        tradeLane: candidate.tradeLane,
        qualificationPath: candidate.qualificationPath,
        qualityScore: candidate.qualityScore,
        researchConfidence: candidate.researchConfidence,
        createdAt: candidate.createdAt,
        latestDecision: candidate.stage && candidate.decision
          ? {
              stage: candidate.stage,
              decision: candidate.decision,
              category,
              reasons: text,
              createdAt: candidate.decisionCreatedAt,
            }
          : null,
      };
    });

    const byStatus = Object.fromEntries(
      Object.values(TradeCandidateStatus).map((status) => [
        status,
        candidateGroups.filter((g) => g.status === status).reduce((sum, g) => sum + Number(g.count), 0),
      ])
    );
    const byLane = candidateGroups.reduce<Record<string, number>>((acc, group) => {
      const key = group.tradeLane ?? "UNKNOWN";
      acc[key] = (acc[key] ?? 0) + Number(group.count);
      return acc;
    }, {});
    const byQualificationPath = candidateGroups.reduce<Record<string, number>>((acc, group) => {
      const key = group.qualificationPath ?? "UNKNOWN";
      acc[key] = (acc[key] ?? 0) + Number(group.count);
      return acc;
    }, {});
    const reasonSummary = Array.from(reasonBuckets.entries())
      .map(([category, bucket]) => ({ category, count: bucket.count, examples: bucket.examples }))
      .sort((a, b) => b.count - a.count);

    let headline = "No active entry is queued.";
    if (openPositions > 0) headline = "Capital is currently in open positions.";
    else if (activePendingEntries > 0) headline = "The bot has active pending entries waiting for price triggers.";
    else if (circuitBreakers.paused) headline = "New entries are paused by a circuit breaker.";
    else if (circuitBreakers.mode === "CONSERVATIVE") headline = "Loss controls are active; only high-conviction entries can pass.";
    else if ((byStatus.WAITING ?? 0) === 0 && (byStatus.QUALIFIED ?? 0) === 0) headline = "No recent candidate currently clears the trade bar.";

    const labelTrade = (trade: typeof latestTrade) =>
      trade && {
        token: trade.token.symbol || trade.token.name || trade.token.address.slice(0, 8),
        status: trade.status,
        createdAt: trade.createdAt,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        realizedPnlUsd: trade.realizedPnlUsd,
        realizedMultiple: trade.realizedMultiple,
        exitReason: trade.exitReason,
      };

    return {
      since,
      today,
      headline,
      circuitBreakers,
      activeStrategy: { id: activeStrategy.id, name: activeStrategy.name, version: activeStrategy.version, status: activeStrategy.status },
      counts: {
        candidates: candidateGroups.reduce((sum, g) => sum + Number(g.count), 0),
        byStatus,
        byLane,
        byQualificationPath,
        activePendingEntries,
        openPositions,
        tradesToday: tradesToday.length,
      },
      reasonSummary,
      recentCandidates: recent,
      tradesToday: tradesToday.map(labelTrade),
      latestTrade: labelTrade(latestTrade),
    };
  });

  app.get("/trade-candidates", async (req) => {
    const { status, limit, offset, q } = req.query as { status?: string; limit?: string; offset?: string; q?: string };
    const take = Math.min(Number(limit) || 50, 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const search = q?.trim();
    const searchFilter = search
      ? search.startsWith("0x")
        ? { token: { address: { contains: search, mode: "insensitive" as const } } }
        : {
            token: {
              OR: [
                { name: { contains: search, mode: "insensitive" as const } },
                { symbol: { contains: search, mode: "insensitive" as const } },
                { address: { contains: search, mode: "insensitive" as const } },
              ],
            },
          }
      : {};

    // An explicit status filter behaves as a plain paginated query — the
    // WAITING-first bucketing below is specifically the "no filter" default
    // dashboard view, where a candidate actively waiting for an entry
    // trigger is the single most important thing to spot at a glance and
    // shouldn't be pushed off-page by pagination.
    if (status) {
      return db.tradeCandidate.findMany({
        where: { status: status as never, ...searchFilter },
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: { token: true, outcome: true },
      });
    }

    const [waiting, rest] = await Promise.all([
      db.tradeCandidate.findMany({
        where: { status: "WAITING" as never, ...searchFilter },
        orderBy: { createdAt: "desc" },
        include: { token: true, outcome: true },
      }),
      db.tradeCandidate.findMany({
        where: { status: { not: "WAITING" as never }, ...searchFilter },
        orderBy: { createdAt: "desc" },
        take,
        skip,
        include: { token: true, outcome: true },
      }),
    ]);
    return { candidates: [...waiting, ...rest], hasMore: rest.length === take };
  });

  app.get("/trade-candidates/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const candidate = await db.tradeCandidate.findUnique({
      where: { id },
      include: {
        token: true,
        outcome: true,
        plans: { orderBy: { createdAt: "desc" }, include: { pendingEntry: true } },
        decisions: { orderBy: { createdAt: "desc" } },
        trades: true,
      },
    });
    if (!candidate) return reply.code(404).send({ error: "not found" });
    return candidate;
  });

  app.get("/trade-plans", async (req) => {
    const { limit } = req.query as { limit?: string };
    return db.tradePlan.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit) || 50, 200),
      include: { candidate: { include: { token: true } }, pendingEntry: true },
    });
  });

  app.get("/pending-entries", async (req) => {
    const { status } = req.query as { status?: string };
    const parsed = status && (Object.values(PendingEntryStatus) as string[]).includes(status) ? (status as PendingEntryStatus) : undefined;
    return db.pendingEntry.findMany({
      where: parsed ? { status: parsed } : undefined,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { tradePlan: { include: { candidate: { include: { token: true } } } } },
    });
  });

  app.post("/pending-entries/:id/cancel", async (req, reply) => {
    const { id } = req.params as { id: string };
    const entry = await db.pendingEntry.findUnique({ where: { id } });
    if (!entry) return reply.code(404).send({ error: "not found" });
    if (entry.status !== PendingEntryStatus.ACTIVE) {
      return reply.code(409).send({ error: `cannot cancel a pending entry in status ${entry.status}` });
    }
    return db.pendingEntry.update({ where: { id }, data: { status: PendingEntryStatus.CANCELLED } });
  });

  app.get("/positions", async () => {
    return db.trade.findMany({
      where: { status: { in: [TradeStatus.OPEN, TradeStatus.PARTIALLY_EXITED] } },
      include: { token: true, snapshots: { orderBy: { capturedAt: "desc" }, take: 1 } },
    });
  });

  app.get("/trades", async (req) => {
    const { status, limit } = req.query as { status?: string; limit?: string };
    const parsed = status && (Object.values(TradeStatus) as string[]).includes(status) ? (status as TradeStatus) : undefined;
    return db.trade.findMany({
      where: parsed ? { status: parsed } : undefined,
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit) || 50, 200),
      include: { token: true },
    });
  });

  app.get("/trades/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const trade = await db.trade.findUnique({
      where: { id },
      include: {
        token: true,
        executions: { orderBy: { createdAt: "asc" } },
        snapshots: { orderBy: { capturedAt: "asc" } },
        exitSignals: { orderBy: { createdAt: "asc" } },
        decisions: { orderBy: { createdAt: "asc" } },
        postmortem: true,
      },
    });
    if (!trade) return reply.code(404).send({ error: "not found" });
    return trade;
  });

  app.get("/portfolio", async () => getPortfolioState());

  app.get("/portfolio/history", async (req) => {
    const { limit } = req.query as { limit?: string };
    return db.portfolioSnapshot.findMany({ orderBy: { capturedAt: "desc" }, take: Math.min(Number(limit) || 100, 500) });
  });

  app.get("/ledger", async (req) => {
    const { limit } = req.query as { limit?: string };
    return db.ledgerEntry.findMany({ orderBy: { occurredAt: "desc" }, take: Math.min(Number(limit) || 100, 500) });
  });

  app.get("/strategies", async () => db.strategyVersion.findMany({ orderBy: { createdAt: "desc" } }));

  app.get("/execution-quality", async (req) => {
    const { limit, tokenAddress } = req.query as { limit?: string; tokenAddress?: string };
    return db.executionQualityStat.findMany({
      where: tokenAddress ? { tokenAddress: tokenAddress.toLowerCase() } : undefined,
      orderBy: [{ failures: "desc" }, { suspiciousQuotes: "desc" }, { lastSeenAt: "desc" }],
      take: Math.min(Number(limit) || 100, 500),
    });
  });

  app.get("/strategies/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const strategy = await db.strategyVersion.findUnique({ where: { id } });
    if (!strategy) return reply.code(404).send({ error: "not found" });
    return strategy;
  });

  app.post("/strategies/:id/promote", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { status } = req.body as { status?: string };
    if (!status || !(Object.values(StrategyStatus) as string[]).includes(status)) {
      return reply.code(400).send({ error: "body must include a valid `status`" });
    }
    try {
      return await promoteStrategyVersion(id, status as StrategyStatus);
    } catch (err) {
      return reply.code(409).send({ error: String(err) });
    }
  });

  app.post("/strategies/variants", async (req, reply) => {
    const body = req.body as {
      parentStrategyVersionId?: string;
      name?: string;
      version: string;
      configuration?: object;
      scoringWeights?: object;
      entryRules?: object;
      sizingRules?: object;
      exitRules?: object;
    };
    if (!body.version) return reply.code(400).send({ error: "body.version is required" });
    const parent = body.parentStrategyVersionId
      ? await db.strategyVersion.findUnique({ where: { id: body.parentStrategyVersionId } })
      : await getActiveStrategyVersion();
    if (!parent) return reply.code(404).send({ error: "parent strategy version not found" });
    return db.strategyVersion.create({
      data: {
        name: body.name ?? parent.name,
        version: body.version,
        status: StrategyStatus.DRAFT,
        configuration: { ...(parent.configuration as object), ...(body.configuration ?? {}) } as object,
        scoringWeights: { ...(parent.scoringWeights as object), ...(body.scoringWeights ?? {}) } as object,
        entryRules: { ...(parent.entryRules as object), ...(body.entryRules ?? {}) } as object,
        sizingRules: { ...(parent.sizingRules as object), ...(body.sizingRules ?? {}) } as object,
        exitRules: { ...(parent.exitRules as object), ...(body.exitRules ?? {}) } as object,
        parentVersionId: parent.id,
      },
    });
  });

  app.get("/learning/candidate-outcomes", async (req) => {
    const { limit } = req.query as { limit?: string };
    return db.candidateOutcome.findMany({
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(limit) || 100, 500),
      include: { candidate: { include: { token: true } } },
    });
  });

  // --- Backtesting (§69/§70) ---

  app.post("/backtests", async (req, reply) => {
    const body = req.body as { fromDate?: string; toDate?: string; strategyVersionId?: string };
    const fromDate = body.fromDate ? new Date(body.fromDate) : new Date(Date.now() - 30 * 24 * 3600_000);
    const toDate = body.toDate ? new Date(body.toDate) : new Date();
    const strategy = body.strategyVersionId
      ? await db.strategyVersion.findUnique({ where: { id: body.strategyVersionId } })
      : await getActiveStrategyVersion();
    if (!strategy) return reply.code(404).send({ error: "strategy version not found" });
    const result = await runBacktest({
      exitRules: strategy.exitRules as never,
      fromDate,
      toDate,
      strategyVersionId: strategy.id,
    });
    return result;
  });

  app.post("/backtests/entry-rules", async (req) => {
    const body = req.body as {
      fromDate?: string;
      toDate?: string;
      strategyVersionId?: string;
      rules?: Partial<Parameters<typeof runEntryBacktest>[0]["rules"]>;
    };
    const fromDate = body.fromDate ? new Date(body.fromDate) : new Date(Date.now() - 30 * 24 * 3600_000);
    const toDate = body.toDate ? new Date(body.toDate) : new Date();
    const rules = {
      minLiquidityUsd: body.rules?.minLiquidityUsd ?? tradingConfig.minTradeLiquidityUsd,
      minHourlyTxns: body.rules?.minHourlyTxns ?? tradingConfig.normalMinHourlyTxns,
      minBuyRatio1h: body.rules?.minBuyRatio1h ?? tradingConfig.normalMinBuyRatio1h,
      maxBuyRatio1h: body.rules?.maxBuyRatio1h ?? tradingConfig.normalMaxBuyRatio1h,
      maxVolumeToLiquidity1h: body.rules?.maxVolumeToLiquidity1h ?? tradingConfig.normalMaxVolumeToLiquidity1h,
      maxRecentRunUpPercent: body.rules?.maxRecentRunUpPercent ?? tradingConfig.conservativeMaxRecentRunUpPercent,
      lookbackMinutes: body.rules?.lookbackMinutes ?? tradingConfig.conservativeRecentWindowMinutes,
    };
    return runEntryBacktest({ rules, fromDate, toDate, strategyVersionId: body.strategyVersionId });
  });

  app.get("/backtests", async (req) => {
    const { limit } = req.query as { limit?: string };
    return db.backtestRun.findMany({ orderBy: { createdAt: "desc" }, take: Math.min(Number(limit) || 50, 200) });
  });

  app.get("/backtests/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = await db.backtestRun.findUnique({ where: { id } });
    if (!run) return reply.code(404).send({ error: "not found" });
    return run;
  });

  // --- Learning / ML (§62-§66) — recommendation surface only, never wired
  // into planning.ts or riskEngine.ts. ---

  app.get("/learning/features", async () => {
    const rows = await exportFeatureDataset();
    return { sampleSize: rows.length, rows };
  });

  app.get("/learning/summary", async () => {
    const rows = await exportFeatureDataset();
    const target: OutcomeLabel = "hit1000x";
    return {
      sampleSize: rows.length,
      tradeLaneHitRates: computeOutcomeRateByTradeLane(rows, target),
      qualificationPathHitRates: computeOutcomeRateByQualificationPath(rows, target),
      target,
      outlierCounts: {
        hit5x: rows.filter((r) => r.hit500x).length,
        hit10x: rows.filter((r) => r.hit1000x).length,
        hit25x: rows.filter((r) => r.hit2500x).length,
        hit50x: rows.filter((r) => r.hit5000x).length,
        hit100x: rows.filter((r) => r.hit10000x).length,
      },
      feasibleOutlierCounts: {
        hit5x: rows.filter((r) => r.feasibleHit500x).length,
        hit10x: rows.filter((r) => r.feasibleHit1000x).length,
        hit25x: rows.filter((r) => r.feasibleHit2500x).length,
        hit50x: rows.filter((r) => r.feasibleHit5000x).length,
        hit100x: rows.filter((r) => r.feasibleHit10000x).length,
      },
    };
  });

  const VALID_LABELS: OutcomeLabel[] = [
    "hit125x",
    "hit150x",
    "hit200x",
    "hit250x",
    "hit500x",
    "hit1000x",
    "hit2500x",
    "hit5000x",
    "hit10000x",
    "feasibleHit125x",
    "feasibleHit150x",
    "feasibleHit200x",
    "feasibleHit250x",
    "feasibleHit500x",
    "feasibleHit1000x",
    "feasibleHit2500x",
    "feasibleHit5000x",
    "feasibleHit10000x",
  ];

  app.post("/learning/train", async (req, reply) => {
    const { targetLabel } = req.body as { targetLabel?: string };
    if (!targetLabel || !VALID_LABELS.includes(targetLabel as OutcomeLabel)) {
      return reply.code(400).send({ error: `targetLabel must be one of ${VALID_LABELS.join(", ")}` });
    }
    return trainOrAnalyze(targetLabel as OutcomeLabel);
  });

  app.get("/learning/models", async (req) => {
    const { limit } = req.query as { limit?: string };
    return db.mLModelVersion.findMany({ orderBy: { trainedAt: "desc" }, take: Math.min(Number(limit) || 50, 200) });
  });
}
