import { decodeEventLog, getAddress } from "viem";
import { db } from "../src/db";
import { ExecutionType } from "../src/generated/prisma";
import { getEthPriceUsd } from "../src/trading/portfolio";
import { POOL_MANAGER_ABI, UNISWAP_V4_ADDRESSES } from "../src/trading/live/contracts";
import { getPublicClient } from "../src/trading/live/wallet";
import { getTokenDecimals } from "../src/trading/live/tokenUtils";

/**
 * One-off, human-run ABI verification for PoolManager.Swap before relying on
 * decoded logs in trading analysis.
 *
 * Run with a production DB/RPC context, for example:
 *   railway run -- npx tsx scripts/verify-swap-event-abi.ts
 *
 * Or pin a specific known transaction:
 *   VERIFY_SWAP_TX_HASH=0x... railway run -- npx tsx scripts/verify-swap-event-abi.ts
 */
async function main() {
  const execution = process.env.VERIFY_SWAP_TX_HASH
    ? await db.tradeExecution.findFirst({
        where: { txHash: process.env.VERIFY_SWAP_TX_HASH },
      })
    : await db.tradeExecution.findFirst({
        where: { txHash: { not: null }, type: ExecutionType.BUY },
        orderBy: { createdAt: "desc" },
      });

  if (!execution?.txHash) {
    throw new Error("No live trade execution with txHash found. Set VERIFY_SWAP_TX_HASH=0x... to verify a specific transaction.");
  }

  const trade = await db.trade.findUniqueOrThrow({
    where: { id: execution.tradeId },
    include: { token: true, tradePlan: true },
  });
  const client = getPublicClient();
  const receipt = await client.getTransactionReceipt({ hash: execution.txHash as `0x${string}` });
  const token = getAddress(trade.token.address);
  const tokenDecimals = await getTokenDecimals(client as unknown as Parameters<typeof getTokenDecimals>[0], token);
  const ethUsd = await getEthPriceUsd();
  if (ethUsd === undefined) throw new Error("No ETH/USD rate available for price cross-check");

  const poolManager = UNISWAP_V4_ADDRESSES.poolManager.toLowerCase();
  const swapLogs = receipt.logs.filter((log) => log.address.toLowerCase() === poolManager);
  if (swapLogs.length === 0) throw new Error(`No PoolManager logs found in receipt ${execution.txHash}`);

  console.log(`Verifying ${execution.type} execution ${execution.id}`);
  console.log(`txHash: ${execution.txHash}`);
  console.log(`token: ${trade.token.symbol ?? trade.token.name} (${token})`);
  console.log(`entryPriceUsd: ${trade.entryPriceUsd ?? "unknown"}`);
  console.log(`plan/current mcap: ${trade.tradePlan?.currentMarketCap ?? trade.actualEntryMcap ?? "unknown"}`);

  let decodedCount = 0;
  for (const log of swapLogs) {
    try {
      const receiptLog = log as { data: `0x${string}`; topics: [`0x${string}`, ...`0x${string}`[]]; blockNumber: bigint; logIndex: number };
      const decoded = decodeEventLog({ abi: POOL_MANAGER_ABI, data: receiptLog.data, topics: receiptLog.topics }) as {
        eventName: string;
        args: unknown;
      };
      if (decoded.eventName !== "Swap") continue;
      decodedCount++;
      const args = decoded.args as {
        id: `0x${string}`;
        sender: `0x${string}`;
        amount0: bigint;
        amount1: bigint;
        sqrtPriceX96: bigint;
        liquidity: bigint;
        tick: number;
        fee: number;
      };
      const priceInEth = sqrtPriceX96ToTokenPriceInEth(args.sqrtPriceX96, tokenDecimals);
      const priceUsd = priceInEth * ethUsd;
      const mcapMultiplier =
        trade.entryPriceUsd && trade.actualEntryMcap
          ? trade.actualEntryMcap / trade.entryPriceUsd
          : trade.entryPriceUsd && trade.tradePlan?.currentMarketCap
            ? trade.tradePlan.currentMarketCap / trade.entryPriceUsd
            : undefined;
      const decodedMcap = mcapMultiplier ? priceUsd * mcapMultiplier : undefined;
      const expectedSigns =
        execution.type === ExecutionType.BUY
          ? args.amount0 > 0n && args.amount1 < 0n
          : execution.type === ExecutionType.SELL
            ? args.amount0 < 0n && args.amount1 > 0n
            : undefined;

      console.log("");
      console.log(`Swap log #${decodedCount} at block ${receiptLog.blockNumber}, logIndex ${receiptLog.logIndex}`);
      console.log(`poolId: ${args.id}`);
      console.log(`amount0 (native ETH): ${args.amount0.toString()}`);
      console.log(`amount1 (token): ${args.amount1.toString()}`);
      console.log(`sign check vs ${execution.type}: ${expectedSigns === undefined ? "n/a" : expectedSigns ? "PASS" : "CHECK MANUALLY"}`);
      console.log(`sqrtPriceX96: ${args.sqrtPriceX96.toString()}`);
      console.log(`decoded token price: ${priceUsd}`);
      console.log(`decoded market cap: ${decodedMcap ?? "unknown (no multiplier)"}`);
      console.log(`liquidity: ${args.liquidity.toString()}, tick: ${args.tick}, fee: ${args.fee}`);
    } catch {
      continue;
    }
  }

  if (decodedCount === 0) throw new Error(`PoolManager logs existed, but none decoded as Swap for ${execution.txHash}`);
  console.log("");
  console.log("Verify 2-3 real txs before trusting this ABI in live entry planning.");
}

function sqrtPriceX96ToTokenPriceInEth(sqrtPriceX96: bigint, tokenDecimals: number): number {
  const Q96 = 2 ** 96;
  const raw = (Number(sqrtPriceX96) / Q96) ** 2;
  return raw * 10 ** (tokenDecimals - 18);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
