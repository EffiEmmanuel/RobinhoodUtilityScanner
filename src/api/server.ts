import Fastify from "fastify";
import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { health as pollerHealth } from "../pipeline/orchestrator";
import { TokenStatus } from "../generated/prisma";

function parseTokenStatus(value: string | undefined): TokenStatus | undefined {
  if (value && (Object.values(TokenStatus) as string[]).includes(value)) return value as TokenStatus;
  return undefined;
}

/**
 * Minimal read-only admin surface (§19/§28). Deliberately not a dashboard —
 * just enough to inspect what the agent is doing without opening the DB
 * directly. Query Postgres (or `yarn db:studio`) for anything deeper.
 */
export function buildServer() {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req, reply) => {
    if (!config.apiKey) return; // no auth configured — fine for local/VPS-behind-firewall use
    if (req.headers["x-api-key"] !== config.apiKey) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/health", async () => {
    let database: "ok" | "error" = "ok";
    try {
      await db.token.count();
    } catch {
      database = "error";
    }
    return {
      status: database === "ok" ? "ok" : "degraded",
      database,
      poller: pollerHealth.running ? "ok" : "stopped",
      lastDiscoveryPoll: pollerHealth.lastDiscoveryPollAt?.toISOString() ?? null,
      lastDiscoveryError: pollerHealth.lastDiscoveryError ?? null,
    };
  });

  app.get("/tokens", async (req) => {
    const { status, limit } = req.query as { status?: string; limit?: string };
    const parsedStatus = parseTokenStatus(status);
    return db.token.findMany({
      where: parsedStatus ? { status: parsedStatus } : undefined,
      orderBy: { firstSeenAt: "desc" },
      take: Math.min(Number(limit) || 50, 200),
    });
  });

  app.get("/tokens/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const token = await db.token.findUnique({
      where: { id },
      include: {
        classifications: { orderBy: { createdAt: "desc" } },
        researchRuns: { orderBy: { createdAt: "desc" } },
        marketSnapshots: { orderBy: { capturedAt: "desc" }, take: 20 },
        alerts: { orderBy: { sentAt: "desc" } },
      },
    });
    if (!token) return reply.code(404).send({ error: "not found" });
    return token;
  });

  app.get("/alerts", async () => {
    return db.alert.findMany({ orderBy: { sentAt: "desc" }, take: 100, include: { token: true } });
  });

  app.get("/watchlist", async () => {
    return db.token.findMany({ where: { status: TokenStatus.WATCHLISTED }, orderBy: { lastSeenAt: "desc" }, take: 100 });
  });

  app.get("/rejected", async () => {
    return db.token.findMany({ where: { status: TokenStatus.REJECTED }, orderBy: { lastSeenAt: "desc" }, take: 100 });
  });

  return app;
}

export async function startApiServer(): Promise<void> {
  const app = buildServer();
  try {
    await app.listen({ port: config.apiPort, host: "0.0.0.0" });
    logger.info({ port: config.apiPort }, "API server listening");
  } catch (err) {
    logger.error({ err: String(err) }, "failed to start API server");
    throw err;
  }
}
