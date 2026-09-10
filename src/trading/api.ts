import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { tradingConfig } from "./config";
import { isTradingEnabled, setTradingEnabled } from "./runtimeState";
import { getPortfolioState, checkCircuitBreakers } from "./portfolio";
import { promoteStrategyVersion } from "./strategy";
import { isWalletConfigured, getWalletAddress } from "./live/wallet";
import { isLiveModeReady, getWalletGasBalanceEth } from "./live/liveExecutionProvider";
import { getAllowedRouterAddresses } from "./live/contracts";
import { runBacktest } from "./backtest";
import { trainOrAnalyze, exportFeatureDataset, type OutcomeLabel } from "./learning";
import { getActiveStrategyVersion } from "./strategy";
import { PendingEntryStatus, StrategyStatus, TradeStatus } from "../generated/prisma";

/** Registers the trading extension's read/control endpoints onto the
 * existing API server (§78). No execution-trigger endpoints exist here —
 * there is nothing for a human or script to "fire" since everything is
 * either autonomous (paper) or read-only. Wallet address is safe to expose
 * (that's the whole point of an address); the private key is never
 * reachable from any module this file imports. */
export function registerTradingRoutes(app: FastifyInstance): void {
  app.get("/trading/status", async () => {
    const [portfolio, circuitBreakers] = await Promise.all([getPortfolioState(), checkCircuitBreakers()]);
    const walletConfigured = isWalletConfigured();
    return {
      mode: tradingConfig.mode,
      tradingEnabled: isTradingEnabled(),
      circuitBreakers,
      portfolio,
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

  const VALID_LABELS: OutcomeLabel[] = ["hit125x", "hit150x", "hit200x", "hit250x"];

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
