import { Connection, PublicKey, type Logs } from "@solana/web3.js";
import { getSolanaConnection } from "../trading/live/solana/wallet";
import { config } from "../config";
import { db } from "../db";
import { logger } from "../logger";
import { cheapFilterOnchain } from "./cheapFilter";
import { TokenStatus } from "../generated/prisma";
import { fetchMarketForToken } from "../dex/client";

/**
 * Solana counterpart to onchainDiscovery.ts — watches pump.fun's own program
 * logs directly via a live websocket subscription instead of waiting on
 * DexScreener's "latest updated profiles" feed to index a new mint. Traced
 * live 2026-09-23: two of the user's own best recent manual picks ("based",
 * "cashtag") were both pump.fun launches the user found on DexScreener
 * before this bot ever saw them — at the time, Solana discovery had no
 * on-chain source at all, only the DexScreener poll. This closes that gap.
 *
 * Same contract as the EVM watcher: a token found here does NOT go to AI. It
 * lands in AWAITING_DEX_PROFILE (or REJECTED if it fails cheapFilterOnchain)
 * and only becomes eligible for classification once a real DexScreener
 * profile shows up for the same mint (discover.ts's poll, or the immediate
 * check below) — this only gets a token INTO the existing pipeline, it never
 * classifies, researches, or trades anything itself, and
 * requireDexProfileToPromote governs promotion exactly as it does for every
 * other discovery source.
 *
 * Only watches pump.fun's bonding-curve program — not every way a Solana
 * token can come into existence (e.g. a mint created and paired directly on
 * Raydium/PumpSwap without ever touching pump.fun). Narrower than the EVM
 * watcher's "every PoolManager pool" scope, but matches both confirmed real
 * examples above; broadening to other launch paths is a follow-up, not
 * something to speculatively build now.
 */

// Confirmed via pump.fun's own published IDL (github.com/pump-fun/pump-
// public-docs, idl/pump.json) as of 2026-09-23, and verified live against
// this project's own SOLANA_RPC_URL (QuickNode) the same day: subscribing to
// this program's logs and decoding matching instructions correctly recovers
// real, freshly-launched mints (e.g. a live "Based ..." coin — the same
// naming pattern as one of the two picks that motivated this watcher).
const PUMP_FUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// pump.fun's `create` and `create_v2` instruction discriminators (first 8
// bytes of instruction data, Anchor's sighash convention). Both instructions
// share the same leading args (name: string, symbol: string, uri: string,
// creator: pubkey) and put the new mint at account index 0, so both decode
// identically below — create_v2 is the one actually in live use (confirmed
// live 2026-09-23: every real launch observed used CreateV2), `create` is
// kept since it's still a valid, unretired instruction per the IDL.
const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const CREATE_V2_DISCRIMINATOR = Buffer.from([214, 144, 76, 236, 95, 139, 49, 180]);

const SOLANA_CHAIN = "solana";

// Exported for solanaOnchainDiscovery.test.ts, same rationale as
// readBorshString below — pure discriminator matching against the constants
// above, worth locking in with a direct test against real captured bytes
// rather than only exercising it indirectly through the IO-wired watcher.
export function isPumpFunCreateInstruction(data: Buffer): boolean {
  const discriminator = data.subarray(0, 8);
  return discriminator.equals(CREATE_DISCRIMINATOR) || discriminator.equals(CREATE_V2_DISCRIMINATOR);
}

// Confirmed live 2026-09-23: this program emits on the order of 100+ raw log
// notifications/second across all of its buy/sell/create/admin traffic — a
// real, healthy subscription should never go anywhere near this long without
// a single one. web3.js's Connection.onLogs doesn't reliably throw when a
// websocket is dead on arrival (it registers a client-side subscription
// intent and returns immediately, before the handshake even completes), so
// "no notifications for too long" is the actual dead-connection signal here,
// not a caught exception.
const STALE_SUBSCRIPTION_MS = 60_000;

let subscribedConnection: Connection | undefined;
let subscriptionId: number | undefined;
let lastNotificationAt = 0;
let scannedSinceLastPoll = 0;
let createdSinceLastPoll = 0;

// Exported for solanaOnchainDiscovery.test.ts — the one piece of this module
// that's pure, deterministic byte parsing rather than loop/IO wiring, so
// it's the piece worth unit-testing (matches this codebase's existing
// pattern of only testing extracted pure logic, e.g. cheapFilter.test.ts,
// utilityGate.test.ts).
export function readBorshString(data: Buffer, offset: number): { value: string; next: number } | undefined {
  if (offset + 4 > data.length) return undefined;
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  if (start + len > data.length) return undefined;
  return { value: data.subarray(start, start + len).toString("utf8"), next: start + len };
}

/**
 * Same fields cheapFilter's immediate-check counterpart in onchainDiscovery.ts
 * populates — a real, indexed DexScreener pair is often available within
 * seconds of a pump.fun launch for anything with genuine early interest,
 * independent of the separate "submitted profile" product
 * AWAITING_DEX_PROFILE otherwise waits on.
 */
async function createSolanaToken(mintAddress: string, name: string | undefined, symbol: string | undefined): Promise<boolean> {
  const existing = await db.token.findUnique({ where: { chain_address: { chain: SOLANA_CHAIN, address: mintAddress } } });
  if (existing) return false; // already known — from DexScreener or an earlier on-chain hit

  // No on-chain supply check here (unlike the EVM watcher's
  // getAdjustedTotalSupply/MEME_SUPPLY_THRESHOLD signal) — every pump.fun
  // launch mints the same fixed supply by protocol design, so a supply-based
  // meme filter would never fire for this source regardless of the token.
  // cheapFilterOnchain already treats an undefined supply as "no signal",
  // the same safe degrade discover.ts relies on for non-EVM chains.
  const filter = cheapFilterOnchain(mintAddress, name, undefined, SOLANA_CHAIN);

  let status: TokenStatus = filter.passed ? TokenStatus.AWAITING_DEX_PROFILE : TokenStatus.REJECTED;
  let iconUrl: string | undefined;
  let headerUrl: string | undefined;
  let rawProfile: object | undefined;

  if (filter.passed) {
    try {
      const market = await fetchMarketForToken(SOLANA_CHAIN, mintAddress);
      const pair = market.primaryPair;
      const hasRealProfile = Boolean(pair?.imageUrl || pair?.headerUrl || (pair?.websites.length ?? 0) > 0 || (pair?.socials.length ?? 0) > 0);
      if (pair && hasRealProfile) {
        status = TokenStatus.DETECTED;
        iconUrl = pair.imageUrl;
        headerUrl = pair.headerUrl;
        rawProfile = {
          source: "solana-onchain-discovery-immediate",
          chainId: SOLANA_CHAIN,
          tokenAddress: mintAddress,
          icon: pair.imageUrl,
          header: pair.headerUrl,
          links: [
            ...pair.websites.map((url) => ({ type: "website", url })),
            ...pair.socials.map((s) => ({ type: s.type, url: s.url })),
          ],
        };
      }
    } catch (err) {
      logger.warn({ mintAddress, err: String(err) }, "solana on-chain discovery: immediate DexScreener check failed — falling back to AWAITING_DEX_PROFILE");
    }
  }

  try {
    await db.token.create({
      data: {
        chain: SOLANA_CHAIN,
        address: mintAddress,
        name,
        symbol,
        status,
        iconUrl,
        headerUrl,
        rawProfile,
        cheapFilterReasons: filter.passed ? undefined : (filter.reasons as unknown as object),
      },
    });
  } catch (err) {
    // P2002 unique-constraint race against the DexScreener discovery loop
    // creating the same (chain, address) row at nearly the same instant —
    // harmless, whichever path won is fine.
    if ((err as { code?: string })?.code !== "P2002") throw err;
    return false;
  }

  logger.info(
    { address: mintAddress, name, symbol, source: "solana-onchain", passed: filter.passed, reasons: filter.reasons },
    "discovered new Solana token via pump.fun on-chain creation"
  );
  return true;
}

/**
 * Decodes a candidate signature's transaction looking for a top-level
 * create/create_v2 instruction targeting pump.fun. Returns whether a new
 * Token row was created.
 */
async function processCandidateSignature(conn: Connection, signature: string): Promise<boolean> {
  let tx;
  try {
    tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  } catch (err) {
    // Rare and non-fatal (confirmed live: an occasional transaction version
    // this RPC client build doesn't recognize) — this one signature is
    // missed, not worth treating as a sustained-failure signal.
    logger.warn({ signature, err: String(err) }, "solana on-chain discovery: could not fetch candidate transaction");
    return false;
  }
  if (!tx) return false;

  const message = tx.transaction.message;
  // Most pump.fun transactions are v0 with address-lookup-table accounts —
  // confirmed live 2026-09-23: without passing the RPC-resolved
  // loadedAddresses back in here, getAccountKeys() throws "address table
  // lookups were not resolved" for the large majority of real transactions,
  // silently dropping almost every genuine create.
  const accountKeys = message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });

  for (const ix of message.compiledInstructions) {
    const programId = accountKeys.get(ix.programIdIndex);
    if (!programId || !programId.equals(PUMP_FUN_PROGRAM_ID)) continue;

    const data = Buffer.from(ix.data);
    if (!isPumpFunCreateInstruction(data)) continue;

    const mintKey = accountKeys.get(ix.accountKeyIndexes[0]);
    if (!mintKey) continue;

    let name: string | undefined;
    let symbol: string | undefined;
    const nameField = readBorshString(data, 8);
    if (nameField) {
      name = nameField.value;
      const symbolField = readBorshString(data, nameField.next);
      if (symbolField) symbol = symbolField.value;
    }

    return createSolanaToken(mintKey.toBase58(), name, symbol);
  }
  return false;
}

async function handleLogNotification(conn: Connection, logs: Logs): Promise<void> {
  if (logs.err) return; // failed tx — nothing real to discover

  // Cheap, in-process pre-filter before paying for a getTransaction round
  // trip — confirmed live 2026-09-23 this program emits 100+ log
  // notifications/sec across all buy/sell/create/admin traffic, and only
  // create/create_v2 ever log an Anchor "Instruction: Create..." line. The
  // discriminator check in processCandidateSignature is still the
  // authoritative match — a slightly loose match here (e.g. also matching
  // CreateTokenAccount) is harmless, it just costs one wasted fetch.
  const looksLikeCreate = logs.logs.some((line) => line.startsWith("Program log: Instruction:") && line.toLowerCase().includes("create"));
  if (!looksLikeCreate) return;

  try {
    const created = await processCandidateSignature(conn, logs.signature);
    if (created) createdSinceLastPoll++;
  } catch (err) {
    logger.warn({ signature: logs.signature, err: String(err) }, "solana on-chain discovery: failed to process a candidate signature");
  }
}

/**
 * Lazily establishes the pump.fun log subscription, and transparently
 * re-establishes it if it's gone stale (see STALE_SUBSCRIPTION_MS). A
 * staleness-triggered resubscribe throws once so the caller's own
 * poll-failure backoff (see orchestrator.ts's solanaOnchainDiscoveryLoop,
 * copied from onchainDiscoveryLoop's RPC-outage handling) takes over the
 * retry cadence during a genuine sustained outage, instead of this module
 * hand-rolling a second, parallel backoff mechanism.
 */
function ensureFreshSubscription(): void {
  const conn = getSolanaConnection();
  const isStale = subscriptionId !== undefined && lastNotificationAt > 0 && Date.now() - lastNotificationAt > STALE_SUBSCRIPTION_MS;
  if (subscriptionId !== undefined && !isStale) return;

  if (subscriptionId !== undefined) {
    subscribedConnection?.removeOnLogsListener(subscriptionId).catch(() => undefined);
    subscriptionId = undefined;
  }

  subscriptionId = conn.onLogs(
    PUMP_FUN_PROGRAM_ID,
    (logs) => {
      lastNotificationAt = Date.now();
      scannedSinceLastPoll++;
      handleLogNotification(conn, logs).catch((err) => {
        logger.error({ err: String(err) }, "solana on-chain discovery: log handler crashed");
      });
    },
    "confirmed"
  );
  subscribedConnection = conn;
  lastNotificationAt = Date.now();

  if (isStale) {
    throw new Error("solana on-chain discovery: pump.fun log subscription went stale (no notifications received) — resubscribed");
  }
  logger.info({ programId: PUMP_FUN_PROGRAM_ID.toBase58() }, "subscribed to pump.fun program logs for Solana on-chain discovery");
}

export async function runSolanaOnchainDiscoveryPoll(): Promise<{ scanned: number; created: number }> {
  // Solana isn't configured in every deployment (see config.ts) — inert, not
  // an error, same as walletTrackingLoop's own enabled-flag guard.
  if (!config.solanaRpcUrl) return { scanned: 0, created: 0 };

  ensureFreshSubscription();

  const scanned = scannedSinceLastPoll;
  const created = createdSinceLastPoll;
  scannedSinceLastPoll = 0;
  createdSinceLastPoll = 0;
  return { scanned, created };
}
