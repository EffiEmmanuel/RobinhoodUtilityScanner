import { db } from "../src/db";
import { summarizeError } from "../src/util/errors";
import { runWalletTrackingPoll } from "../src/walletTracking/poller";

async function main() {
  const result = await runWalletTrackingPoll();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((err) => {
    console.error(summarizeError(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
