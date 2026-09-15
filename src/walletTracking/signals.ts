import { WalletEventDirection } from "../generated/prisma";
import { db } from "../db";

export interface TokenWalletSignalSummary {
  trackedWalletCount: number;
  tokenInEvents: number;
  tokenOutEvents: number;
  possibleBuyCount: number;
  possibleSellCount: number;
  latestEventAt?: Date;
  latestBlock?: bigint;
  walletLabels: string[];
  notes: string[];
}

export async function getWalletSignalsForToken(tokenId: string, tokenAddress: string): Promise<TokenWalletSignalSummary> {
  const events = await db.trackedWalletEvent.findMany({
    where: {
      OR: [{ tokenId }, { tokenAddress: tokenAddress.toLowerCase() }],
    },
    include: { wallet: true },
    orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
    take: 50,
  });

  const walletIds = new Set(events.map((event) => event.walletId));
  const labels = new Set<string>();
  for (const event of events) labels.add(event.wallet.label ?? event.wallet.address);

  const latest = events[0];
  return {
    trackedWalletCount: walletIds.size,
    tokenInEvents: events.filter((event) => event.direction === WalletEventDirection.TOKEN_IN).length,
    tokenOutEvents: events.filter((event) => event.direction === WalletEventDirection.TOKEN_OUT).length,
    possibleBuyCount: events.filter((event) => event.classification === "POSSIBLE_BUY").length,
    possibleSellCount: events.filter((event) => event.classification === "POSSIBLE_SELL").length,
    latestEventAt: latest?.blockTimestamp ?? latest?.createdAt,
    latestBlock: latest?.blockNumber,
    walletLabels: Array.from(labels).slice(0, 8),
    notes: events.slice(0, 8).map((event) => {
      const amount = event.tokenAmount !== null ? `${event.tokenAmount.toLocaleString()} tokens` : `raw ${event.rawAmount}`;
      return `${event.wallet.label ?? event.wallet.address} ${event.classification ?? event.direction} ${amount} in tx ${event.txHash}`;
    }),
  };
}

export function formatWalletSignalsForPrompt(signals: TokenWalletSignalSummary): string {
  if (signals.trackedWalletCount === 0) {
    return "No tracked-wallet activity has been recorded for this token.";
  }

  return [
    `Tracked wallets involved: ${signals.trackedWalletCount}`,
    `Token-in events: ${signals.tokenInEvents}`,
    `Token-out events: ${signals.tokenOutEvents}`,
    `Possible buys: ${signals.possibleBuyCount}`,
    `Possible sells: ${signals.possibleSellCount}`,
    signals.latestEventAt ? `Latest tracked-wallet event: ${signals.latestEventAt.toISOString()}` : undefined,
    signals.latestBlock !== undefined ? `Latest tracked-wallet block: ${signals.latestBlock.toString()}` : undefined,
    `Wallets: ${signals.walletLabels.join(", ") || "(labels unavailable)"}`,
    "",
    "Important: wallet Transfer logs prove token movement, not trading intent. Treat POSSIBLE_BUY/POSSIBLE_SELL as a discovery/research signal only, never as a reason to blindly copy the wallet.",
    "",
    "Recent wallet notes:",
    signals.notes.map((note) => `- ${note}`).join("\n") || "- none",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
