import dns from "node:dns";
import { config, assertRuntimeConfig } from "./config";
import { logger } from "./logger";
import { db } from "./db";
import { startOrchestrator } from "./pipeline/orchestrator";
import { startTradingOrchestrator } from "./trading/orchestrator";
import { tradingConfig } from "./trading/config";
import { startApiServer } from "./api/server";

// Confirmed live 2026-09-12 on Railway: every SMTP send failed with
// "connect ENETUNREACH <ipv6 addr>:465" — Node's dns.lookup() (used by
// nodemailer's plain net/tls connect) returned smtp.gmail.com's IPv6 address
// first, and Railway's network has no outbound IPv6 route to it. Worked fine
// locally, where IPv6 routing exists. This changes the DEFAULT lookup order
// for the whole process (Node 18+) rather than patching nodemailer alone —
// any other host with the same "advertises AAAA, can't actually route it"
// problem (RPC, DexScreener, X) gets the same fix for free.
dns.setDefaultResultOrder("ipv4first");

async function main() {
  const missing = assertRuntimeConfig();
  if (missing.length > 0) {
    logger.warn(
      { missing },
      "some config is missing — the pipeline will run but classification/research/alerting will fail until these are set in .env"
    );
  }

  logger.info(
    { targetChain: config.targetChainId, pollSeconds: config.discoveryIntervalSeconds, tradingMode: tradingConfig.mode },
    "starting UtilityScout"
  );

  await startApiServer();
  const stopOrchestrator = await startOrchestrator();
  const stopTradingOrchestrator = await startTradingOrchestrator();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    stopOrchestrator();
    stopTradingOrchestrator();
    await db.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err: String(err) }, "fatal startup error");
  process.exit(1);
});
