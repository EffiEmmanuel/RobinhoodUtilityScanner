import { getAddress } from "viem";
import { db } from "../src/db";
import { config } from "../src/config";
import { TrackedWalletConfidence, TrackedWalletStatus } from "../src/generated/prisma";

async function main() {
  const rawAddress = process.argv[2];
  if (!rawAddress) {
    throw new Error("Usage: yarn tsx scripts/track-wallet.ts <wallet-address> [label]");
  }

  const address = getAddress(rawAddress).toLowerCase();
  const label = process.argv.slice(3).join(" ").trim() || undefined;

  const wallet = await db.trackedWallet.upsert({
    where: { chain_address: { chain: config.targetChainId, address } },
    update: {
      status: TrackedWalletStatus.ACTIVE,
      label,
      confidence: TrackedWalletConfidence.USER_SUPPLIED,
      source: "user-supplied",
    },
    create: {
      chain: config.targetChainId,
      address,
      label,
      status: TrackedWalletStatus.ACTIVE,
      confidence: TrackedWalletConfidence.USER_SUPPLIED,
      source: "user-supplied",
      tags: ["creator-watch"] as unknown as object,
      notes: "Initial wallet added by user for discovery-phase wallet tracking.",
    },
  });

  console.log(`tracking wallet ${wallet.address}${wallet.label ? ` (${wallet.label})` : ""} on ${wallet.chain}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
