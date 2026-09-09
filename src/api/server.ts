import { readFileSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import { db } from "../db";
import { config } from "../config";
import { logger } from "../logger";
import { health as pollerHealth } from "../pipeline/orchestrator";
import { registerTradingRoutes } from "../trading/api";
import { TokenStatus } from "../generated/prisma";

// Read once at startup — served as a static page, not templated.
const dashboardHtml = readFileSync(join(__dirname, "dashboard.html"), "utf-8");

function parseTokenStatus(value: string | undefined): TokenStatus | undefined {
  if (value && (Object.values(TokenStatus) as string[]).includes(value)) return value as TokenStatus;
  return undefined;
}

/**
 * Read-only admin/data API (§19/§28), plus a static monitoring dashboard at
 * /dashboard served from the same origin — avoids the CORS/CSP problems of
 * hosting the dashboard anywhere else and talking to this API cross-origin.
 */
export function buildServer() {
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (req, reply) => {
    // Read-only data, no secrets ever returned here — CORS is open so the
    // browser-based monitoring dashboard can poll this from any origin.
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Headers", "x-api-key, content-type");
    // Chrome's Private Network Access policy requires this explicit opt-in
    // for a public HTTPS page (the dashboard, served from claude.ai) to reach
    // a loopback/private address like this local server — without it, the
    // preflight is blocked even though Access-Control-Allow-Origin is set.
    reply.header("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }
    // Static page and infra health checks (Railway, uptime monitors) stay
    // key-free — neither returns anything sensitive.
    if (req.url.startsWith("/dashboard") || req.url.startsWith("/health")) return;
    if (!config.apiKey) return; // no auth configured — fine for local/VPS-behind-firewall use
    if (req.headers["x-api-key"] !== config.apiKey) {
      reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/dashboard", async (_req, reply) => {
    reply.type("text/html").send(dashboardHtml);
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
      lastOnchainDiscoveryPoll: pollerHealth.lastOnchainDiscoveryPollAt?.toISOString() ?? null,
      lastOnchainDiscoveryError: pollerHealth.lastOnchainDiscoveryError ?? null,
    };
  });

  app.get("/tokens", async (req) => {
    const { status, limit, offset } = req.query as { status?: string; limit?: string; offset?: string };
    const parsedStatus = parseTokenStatus(status);
    return db.token.findMany({
      where: parsedStatus ? { status: parsedStatus } : undefined,
      orderBy: { firstSeenAt: "desc" },
      take: Math.min(Number(limit) || 50, 200),
      skip: Math.max(Number(offset) || 0, 0),
      include: { classifications: { orderBy: { createdAt: "desc" }, take: 1 } },
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

  registerTradingRoutes(app);

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
