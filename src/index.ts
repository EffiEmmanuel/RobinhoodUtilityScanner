import { config, assertRuntimeConfig } from "./config";
import { logger } from "./logger";
import { db } from "./db";
import { startOrchestrator } from "./pipeline/orchestrator";
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
    { targetChain: config.targetChainId, pollSeconds: config.discoveryIntervalSeconds },
    "starting UtilityScout"
  );

  await startApiServer();
  const stopOrchestrator = await startOrchestrator();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    stopOrchestrator();
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
