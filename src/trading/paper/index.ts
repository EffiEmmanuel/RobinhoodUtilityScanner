import { logger } from "../../logger";
import { sleep } from "../../util/http";
import { paperConfig } from "./config";
import { runPaperTick } from "./engine";

export { getPaperStrategyKpis } from "./kpis";
export { paperConfig } from "./config";

/**
 * Its own loop on its own interval: a slow or failing paper tick delays only
 * the next paper tick, never a live loop, and nothing here throws out.
 */
export async function paperStrategiesLoop(signal: { stopped: boolean }): Promise<void> {
  logger.info({ tickSeconds: paperConfig.tickSeconds, maxQuotesPerDay: paperConfig.maxQuotesPerDay }, "paper strategies loop started");
  while (!signal.stopped) {
    try {
      await runPaperTick();
    } catch (err) {
      logger.error({ err: String(err) }, "paper strategies tick failed");
    }
    await sleep(paperConfig.tickSeconds * 1000);
  }
}
