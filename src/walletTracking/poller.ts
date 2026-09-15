import { formatUnits, getAddress, isAddressEqual, parseAbiItem, type Log } from "viem";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { fetchMarketForToken } from "../dex/client";
import { TokenStatus, TrackedWalletStatus, WalletEventDirection, Prisma } from "../generated/prisma";
import { cheapFilterOnchain } from "../pipeline/cheapFilter";
import { getPublicClient } from "../trading/live/wallet";
import { getAdjustedTotalSupply, getTokenDecimals, getTokenNameSymbol } from "../trading/live/tokenUtils";

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

type TransferLog = Log<bigint, number, false, typeof TRANSFER_EVENT, true>;

interface NormalizedWalletTransfer {
  tokenAddress: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  blockNumber: bigint;
  direction: WalletEventDirection;
  rawAmount: bigint;
  from: `0x${string}`;
  to: `0x${string}`;
}

export async function runWalletTrackingPoll(): Promise<{ wallets: number; events: number; discoveredTokens: number }> {
  if (!config.walletTrackingEnabled) return { wallets: 0, events: 0, discoveredTokens: 0 };

  const wallets = await db.trackedWallet.findMany({
    where: { chain: config.targetChainId, status: TrackedWalletStatus.ACTIVE },
    orderBy: { updatedAt: "asc" },
    take: 25,
  });
  if (wallets.length === 0) return { wallets: 0, events: 0, discoveredTokens: 0 };

  const client = getPublicClient();
  const latest = await client.getBlockNumber();
  let events = 0;
  let discoveredTokens = 0;

  for (const wallet of wallets) {
    const walletAddress = getAddress(wallet.address) as `0x${string}`;
    const firstBlock =
      wallet.lastScannedBlock !== null
        ? wallet.lastScannedBlock + 1n
        : latest > BigInt(config.walletTrackingInitialBackfillBlocks)
          ? latest - BigInt(config.walletTrackingInitialBackfillBlocks)
          : 0n;
    if (firstBlock > latest) {
      await db.trackedWallet.update({ where: { id: wallet.id }, data: { lastScannedAt: new Date() } });
      continue;
    }

    const toBlock = firstBlock + BigInt(config.walletTrackingBatchBlocks - 1) < latest ? firstBlock + BigInt(config.walletTrackingBatchBlocks - 1) : latest;
    const transfers = await scanWalletTransfers(walletAddress, firstBlock, toBlock);

    for (const transfer of transfers) {
      const result = await recordWalletTransfer(wallet.id, transfer);
      if (result.created) events++;
      if (result.discoveredToken) discoveredTokens++;
    }

    await db.trackedWallet.update({
      where: { id: wallet.id },
      data: {
        lastScannedBlock: toBlock,
        lastScannedAt: new Date(),
      },
    });
  }

  if (events > 0 || discoveredTokens > 0) {
    logger.info({ wallets: wallets.length, events, discoveredTokens }, "wallet tracking poll complete");
  }
  return { wallets: wallets.length, events, discoveredTokens };
}

async function scanWalletTransfers(walletAddress: `0x${string}`, fromBlock: bigint, toBlock: bigint): Promise<NormalizedWalletTransfer[]> {
  const client = getPublicClient();
  const [incoming, outgoing] = await Promise.all([
    client.getLogs({ event: TRANSFER_EVENT, args: { to: walletAddress }, fromBlock, toBlock }),
    client.getLogs({ event: TRANSFER_EVENT, args: { from: walletAddress }, fromBlock, toBlock }),
  ]);

  const byKey = new Map<string, NormalizedWalletTransfer>();
  for (const log of [...incoming, ...outgoing] as TransferLog[]) {
    const parsed = normalizeTransferLog(walletAddress, log);
    if (!parsed || parsed.rawAmount <= 0n) continue;
    byKey.set(`${parsed.txHash}:${parsed.logIndex}:${parsed.direction}`, parsed);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

function normalizeTransferLog(walletAddress: `0x${string}`, log: TransferLog): NormalizedWalletTransfer | undefined {
  const from = log.args.from;
  const to = log.args.to;
  const value = log.args.value;
  if (!from || !to || value === undefined || !log.transactionHash || log.logIndex === null || log.blockNumber === null) return undefined;

  const inbound = isAddressEqual(to, walletAddress);
  const outbound = isAddressEqual(from, walletAddress);
  const direction = inbound && outbound ? WalletEventDirection.SELF_TRANSFER : inbound ? WalletEventDirection.TOKEN_IN : WalletEventDirection.TOKEN_OUT;
  return {
    tokenAddress: getAddress(log.address) as `0x${string}`,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    direction,
    rawAmount: value,
    from,
    to,
  };
}

async function recordWalletTransfer(
  walletId: string,
  transfer: NormalizedWalletTransfer
): Promise<{ created: boolean; discoveredToken: boolean }> {
  const existing = await db.trackedWalletEvent.findUnique({
    where: {
      walletId_txHash_logIndex_direction: {
        walletId,
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
        direction: transfer.direction,
      },
    },
  });
  if (existing) return { created: false, discoveredToken: false };

  const [token, decimals, market, block] = await Promise.allSettled([
    resolveOrCreateTokenForTransfer(transfer),
    getTokenDecimals(getPublicClient(), transfer.tokenAddress),
    fetchMarketForToken(config.targetChainId, transfer.tokenAddress),
    getPublicClient().getBlock({ blockNumber: transfer.blockNumber }),
  ]);

  const tokenRecord = token.status === "fulfilled" ? token.value.token : null;
  const discoveredToken = token.status === "fulfilled" ? token.value.discovered : false;
  const decimalsValue = decimals.status === "fulfilled" ? decimals.value : undefined;
  const amount = decimalsValue !== undefined ? Number(formatUnits(transfer.rawAmount, decimalsValue)) : undefined;
  const pair = market.status === "fulfilled" ? market.value.primaryPair : undefined;
  const timestamp =
    block.status === "fulfilled" && typeof block.value.timestamp === "bigint"
      ? new Date(Number(block.value.timestamp) * 1000)
      : undefined;

  const classification =
    transfer.direction === WalletEventDirection.TOKEN_IN
      ? "POSSIBLE_BUY"
      : transfer.direction === WalletEventDirection.TOKEN_OUT
        ? "POSSIBLE_SELL"
        : "SELF_TRANSFER";

  await db.trackedWalletEvent.create({
    data: {
      walletId,
      tokenId: tokenRecord?.id,
      chain: config.targetChainId,
      tokenAddress: transfer.tokenAddress.toLowerCase(),
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
      blockNumber: transfer.blockNumber,
      blockTimestamp: timestamp,
      direction: transfer.direction,
      classification,
      confidence: transfer.direction === WalletEventDirection.SELF_TRANSFER ? 0.1 : 0.55,
      rawAmount: transfer.rawAmount.toString(),
      tokenAmount: amount,
      usdValue: amount !== undefined && pair?.priceUsd !== undefined ? amount * pair.priceUsd : undefined,
      marketCapUsd: pair?.marketCapUsd,
      liquidityUsd: pair?.liquidityUsd,
      discoveredToken,
      rawEvent: {
        from: transfer.from,
        to: transfer.to,
        txHash: transfer.txHash,
        logIndex: transfer.logIndex,
        blockNumber: transfer.blockNumber.toString(),
      } as unknown as object,
    },
  });

  return { created: true, discoveredToken };
}

async function resolveOrCreateTokenForTransfer(
  transfer: NormalizedWalletTransfer
): Promise<{ token: { id: string } | null; discovered: boolean }> {
  const address = transfer.tokenAddress.toLowerCase();
  const existing = await db.token.findUnique({ where: { chain_address: { chain: config.targetChainId, address } }, select: { id: true } });
  if (existing) return { token: existing, discovered: false };

  if (transfer.direction !== WalletEventDirection.TOKEN_IN) return { token: null, discovered: false };

  const client = getPublicClient();
  const [nameSymbol, supply, market] = await Promise.allSettled([
    getTokenNameSymbol(client, transfer.tokenAddress),
    getAdjustedTotalSupply(client, transfer.tokenAddress),
    fetchMarketForToken(config.targetChainId, address),
  ]);
  const info = nameSymbol.status === "fulfilled" ? nameSymbol.value : {};
  const adjustedTotalSupply = supply.status === "fulfilled" ? supply.value : undefined;
  const filter = cheapFilterOnchain(address, info.name, adjustedTotalSupply);
  const pair = market.status === "fulfilled" ? market.value.primaryPair : undefined;
  const hasRealProfile = Boolean(pair?.imageUrl || pair?.headerUrl || (pair?.websites.length ?? 0) > 0 || (pair?.socials.length ?? 0) > 0);
  const status = filter.passed && hasRealProfile ? TokenStatus.DETECTED : filter.passed ? TokenStatus.AWAITING_DEX_PROFILE : TokenStatus.REJECTED;

  let token: { id: string };
  try {
    token = await db.token.create({
      data: {
        chain: config.targetChainId,
        address,
        name: info.name,
        symbol: info.symbol,
        status,
        iconUrl: pair?.imageUrl,
        headerUrl: pair?.headerUrl,
        rawProfile: {
          source: "tracked-wallet-transfer",
          chainId: config.targetChainId,
          tokenAddress: address,
          icon: pair?.imageUrl,
          header: pair?.headerUrl,
          links: [
            ...(pair?.websites ?? []).map((url) => ({ type: "website", url })),
            ...(pair?.socials ?? []).map((s) => ({ type: s.type, url: s.url })),
          ],
        } as unknown as object,
        cheapFilterReasons: filter.passed ? Prisma.JsonNull : (filter.reasons as unknown as object),
      },
      select: { id: true },
    });
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2002") throw err;
    const raced = await db.token.findUnique({ where: { chain_address: { chain: config.targetChainId, address } }, select: { id: true } });
    if (!raced) throw err;
    return { token: raced, discovered: false };
  }

  logger.info({ tokenId: token.id, address, status, filterPassed: filter.passed }, "tracked wallet transfer discovered a new token");
  return { token, discovered: true };
}
