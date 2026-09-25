import "dotenv/config";
import { main } from "../src/backtest/cli";

/**
 * OHLCV replay backtester. Read-only against prod: it SELECTs the candidate
 * universe once into data/backtest-cache/universe.json and never writes to
 * the DB. Run `npx tsx scripts/backtest-replay.ts help` for commands.
 */
main(process.argv.slice(2))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
