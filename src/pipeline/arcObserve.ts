import { fetchLatestTokenProfiles, fetchMarketForToken } from "../dex/client";
import { config } from "../config";
import { logger } from "../logger";
import { sendMail } from "../notify/mailer";
import type { MarketPair } from "../dex/types";

// Observation-only visibility into Circle's Arc chain (see config.ts's
// arcObservationEnabled doc comment for why this deliberately bypasses the
// real discovery/trading pipeline entirely). This module never touches the
// DB, never runs a honeypot check, never creates a trade candidate — it
// polls the same DexScreener token-profiles feed discover.ts already uses,
// filters to Arc, and emails when a launch clears a real-activity bar.

const ARC_CHAIN_ID = "arc";

interface ArcCandidate {
  firstSeenAt: number;
  alerted: boolean;
}

// In-memory only, lost on restart — an occasional duplicate alert after a
// redeploy is a fine tradeoff for not needing a schema migration for
// throwaway observation state.
const candidates = new Map<string, ArcCandidate>();

function pruneStale(): void {
  const cutoffMs = Date.now() - config.arcObservationCandidateExpiryHours * 60 * 60 * 1000;
  for (const [address, candidate] of candidates) {
    if (candidate.alerted || candidate.firstSeenAt < cutoffMs) candidates.delete(address);
  }
}

function clearsActivityBar(pair: MarketPair): boolean {
  return (pair.liquidityUsd ?? 0) >= config.arcObservationMinLiquidityUsd && (pair.volume1h ?? 0) >= config.arcObservationMinVolume1hUsd;
}

async function sendObservationAlert(tokenAddress: string, pair: MarketPair): Promise<void> {
  logger.info(
    { tokenAddress, liquidityUsd: pair.liquidityUsd, volume1h: pair.volume1h, dexId: pair.dexId, url: pair.url },
    "Arc launch cleared observation bar"
  );

  if (!config.alertEmailFrom || !config.alertEmailTo) return;
  await sendMail({
    from: config.alertEmailFrom,
    to: config.alertEmailTo,
    subject: `[ARC-OBSERVE] ${pair.baseTokenSymbol ?? tokenAddress.slice(0, 10)} cleared the watch bar`,
    text: [
      `Token: ${pair.baseTokenName ?? "unknown"} (${pair.baseTokenSymbol ?? "?"})`,
      `Contract: ${tokenAddress}`,
      `Dex: ${pair.dexId}`,
      `Liquidity: $${Math.round(pair.liquidityUsd ?? 0).toLocaleString()}`,
      `1h volume: $${Math.round(pair.volume1h ?? 0).toLocaleString()}`,
      `Pair: ${pair.url}`,
      "",
      "Observation-only: no honeypot check has run and no trade candidate was created. Arc is not wired into the real trading pipeline yet.",
    ].join("\n"),
  });
}

export async function runArcObservationPoll(): Promise<{ seen: number; alerted: number }> {
  pruneStale();

  const profiles = await fetchLatestTokenProfiles();
  const arcProfiles = profiles.filter((p) => p.chainId === ARC_CHAIN_ID);

  for (const profile of arcProfiles) {
    if (!candidates.has(profile.tokenAddress)) {
      candidates.set(profile.tokenAddress, { firstSeenAt: Date.now(), alerted: false });
    }
  }

  let alerted = 0;
  for (const [address, candidate] of candidates) {
    if (candidate.alerted) continue;
    try {
      const market = await fetchMarketForToken(ARC_CHAIN_ID, address);
      if (market.primaryPair && clearsActivityBar(market.primaryPair)) {
        await sendObservationAlert(address, market.primaryPair);
        candidate.alerted = true;
        alerted++;
      }
    } catch (err) {
      logger.warn({ address, err: String(err) }, "Arc observation market lookup failed");
    }
  }

  return { seen: arcProfiles.length, alerted };
}
