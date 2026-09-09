import { config, assertRuntimeConfig } from "./config";
import { logger } from "./logger";
import { db } from "./db";
import { startOrchestrator } from "./pipeline/orchestrator";
import { startTradingOrchestrator } from "./trading/orchestrator";
import { tradingConfig } from "./trading/config";
import { startApiServer } from "./api/server";

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
