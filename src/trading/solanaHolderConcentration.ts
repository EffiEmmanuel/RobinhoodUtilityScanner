import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../config";
import { logger } from "../logger";
import { percentOfSupply } from "./holderConcentration";
import type { HolderSnapshot } from "./holderConcentration";

/**
 * Solana counterpart to holderConcentration.ts's getHolderSnapshot. Same
 * output shape (HolderSnapshot) and reuses its evaluateHolderConcentration
 * scoring unchanged — only how the snapshot is gathered differs, since SPL
 * tokens have no Transfer-log-scan equivalent worth doing when the RPC
 * already exposes ranked balances directly.
 *
 * Two known limitations, both fail conservative (stricter, never laxer):
 *  - Pool-vault exclusion is a maintained allowlist of known AMM/launchpad
 *    program IDs (see KNOWN_POOL_PROGRAM_IDS below), not a single fixed
 *    address the way Uniswap v4's singleton PoolManager is on the EVM side —
 *    Solana AMMs each derive their own per-pool vault token account, so
 *    there's no one address to exclude. A pool on a DEX not in this list
 *    reads as one very large "holder," which only makes the concentration
 *    check fail harder, never pass something it shouldn't.
 *  - holderCount comes from a best-effort getProgramAccounts scan (both the
 *    legacy SPL Token program and Token-2022) rather than a guaranteed
 *    complete index. Confirmed live 2026-09-16 against a paid-tier-capable
 *    QuickNode endpoint: this isn't just a free-tier restriction — providers
 *    commonly exclude the Token program itself from "secondary indexes"
 *    ("TokenkegQfeZ... excluded from account secondary indexes; this RPC
 *    method unavailable for key"), since indexing tens of millions of
 *    accounts across every SPL token efficiently needs dedicated indexer
 *    infrastructure most generic RPC providers don't run. A true holder
 *    count would need a specialized indexer API (e.g. Helius's
 *    getTokenAccounts/DAS), not raw getProgramAccounts — a real follow-up if
 *    this metric turns out to matter, not assumed solvable by "pay for a
 *    better RPC plan." On failure this falls back to a count derived from
 *    getTokenLargestAccounts, which actually returns up to 100 (confirmed
 *    live — not the 10 an earlier version of this file wrongly assumed, a
 *    bug that meant holderCount could never exceed 10 and
 *    tradingConfig.minHolderCountForEntry's default of 15 would have failed
 *    every single Solana token, forever, regardless of real distribution).
 *    That fallback count is the raw non-zero-balance count across all ~100,
 *    NOT narrowed by pool exclusion (see POOL_EXCLUSION_WINDOW below) —
 *    a live timing test resolving pool ownership for all 100 top accounts
 *    took 16-28s per check (40 RPC calls, hitting this free-tier RPC's rate
 *    limit repeatedly) for a metric that only needs "are there at least N
 *    holders," not an exact count. A handful of pool vaults miscounted as
 *    "holders" among ~100 doesn't meaningfully change whether that floor is
 *    cleared, so this trades a small, safe overcount for an 5x cheaper call.
 */

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

// Well-known Solana AMM/launchpad program IDs whose pool vault token
// accounts must be excluded from holder ranking. Not exhaustive — see the
// module doc comment above.
const KNOWN_POOL_PROGRAM_IDS = new Set([
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", // Orca Whirlpool
]);

let connection: Connection | undefined;
function getSolanaConnection(): Connection {
  if (!config.solanaRpcUrl) throw new Error("SOLANA_RPC_URL is not set — cannot read Solana holder data");
  if (!connection) connection = new Connection(config.solanaRpcUrl, "confirmed");
  return connection;
}

// Confirmed live 2026-09-16 against a QuickNode free-tier ("discover" plan)
// endpoint: getMultipleAccounts (which both getMultipleParsedAccounts and
// getMultipleAccountsInfo call under the hood) 413s above a batch of 5 on
// that plan. Batching at 5 keeps this working on the cheapest tier most
// providers offer.
const MAX_ACCOUNTS_PER_BATCH = 5;

// Confirmed live: bounding concurrency (tried 3 and 4) didn't fix the
// latency — total call COUNT was the actual bottleneck, not burst size.
// Resolving pool ownership for a 100-account window took 16-28s per check
// regardless of concurrency setting. Narrowing to POOL_EXCLUSION_WINDOW
// below (top1Percent/top10Percent only ever need the top 10 anyway, so 20
// gives ample margin for the realistic 1-4-pools case) cuts this from 40
// RPC calls to 8. Concurrency stays bounded rather than fully parallel
// since a plain Promise.all across even the smaller batch count still
// visibly 429s and retries.
const BATCH_CONCURRENCY = 4;
const POOL_EXCLUSION_WINDOW = 20;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function bestEffortHolderCount(conn: Connection, mint: PublicKey, fallback: number): Promise<number> {
  try {
    const [legacy, token2022] = await Promise.all([
      conn.getProgramAccounts(TOKEN_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }], dataSlice: { offset: 0, length: 0 } }),
      conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }], dataSlice: { offset: 0, length: 0 } }),
    ]);
    return legacy.length + token2022.length;
  } catch (err) {
    logger.warn({ mint: mint.toBase58(), err: String(err) }, "solana holder count scan unavailable (RPC provider commonly excludes the Token program from secondary indexes) — falling back to the getTokenLargestAccounts-derived count");
    return fallback;
  }
}

export async function getSolanaHolderSnapshot(mintAddress: string): Promise<HolderSnapshot | undefined> {
  try {
    const conn = getSolanaConnection();
    const mint = new PublicKey(mintAddress);

    const [supplyResp, largestResp] = await Promise.all([conn.getTokenSupply(mint), conn.getTokenLargestAccounts(mint)]);
    const totalSupply = BigInt(supplyResp.value.amount);
    if (totalSupply <= 0n) return undefined;

    // Everything getTokenLargestAccounts returns — confirmed live this is
    // 100 (its documented max), not the 10 this file used to slice to. Used
    // as-is (raw, no pool exclusion) for the holderCount fallback below; only
    // the narrower POOL_EXCLUSION_WINDOW slice gets the expensive
    // per-account ownership resolution, since that's the only place it
    // actually needs to be exact (top1Percent/top10Percent).
    const topAccounts = largestResp.value;
    if (topAccounts.length === 0) return undefined;
    const exclusionCandidates = topAccounts.slice(0, POOL_EXCLUSION_WINDOW);

    // Resolve each candidate's owning wallet/authority, then check whether
    // THAT authority is itself a PDA controlled by a known pool program —
    // a pool's vault token account is "owned" (in the SPL sense) by a
    // program-derived address, not a human wallet. Batched and
    // concurrency-bounded to stay within free-tier RPC limits (see
    // MAX_ACCOUNTS_PER_BATCH/BATCH_CONCURRENCY doc comments).
    const parsedBatches = await mapWithConcurrency(chunk(exclusionCandidates, MAX_ACCOUNTS_PER_BATCH), BATCH_CONCURRENCY, (batch) =>
      conn.getMultipleParsedAccounts(batch.map((a) => a.address))
    );
    const parsedAccounts = parsedBatches.flatMap((batch) => batch.value);
    const ownerPubkeys = parsedAccounts.map((acc) => {
      const data = acc?.data;
      if (!data || !("parsed" in data)) return undefined;
      const owner = (data.parsed as { info?: { owner?: string } })?.info?.owner;
      return owner ? new PublicKey(owner) : undefined;
    });
    const ownerBatches = await mapWithConcurrency(
      chunk(
        ownerPubkeys.map((pk) => pk ?? PublicKey.default),
        MAX_ACCOUNTS_PER_BATCH
      ),
      BATCH_CONCURRENCY,
      (batch) => conn.getMultipleAccountsInfo(batch)
    );
    const ownerAccountInfos = ownerBatches.flat();

    const holders = exclusionCandidates.map((acct, i) => {
      const ownerProgram = ownerAccountInfos[i]?.owner.toBase58();
      const isPool = ownerProgram !== undefined && KNOWN_POOL_PROGRAM_IDS.has(ownerProgram);
      return { balance: BigInt(acct.amount), isPool };
    });

    const ranked = holders
      .filter((h) => !h.isPool && h.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

    const top1 = ranked.slice(0, 1).reduce((sum, h) => sum + h.balance, 0n);
    const top10 = ranked.slice(0, 10).reduce((sum, h) => sum + h.balance, 0n);
    // Fallback count if getProgramAccounts is unavailable (see module doc
    // comment on why this is a deliberately cheap approximation, not the
    // pool-excluded `ranked` list).
    const rawNonZeroCount = topAccounts.filter((a) => BigInt(a.amount) > 0n).length;
    const holderCount = await bestEffortHolderCount(conn, mint, rawNonZeroCount);

    return {
      totalSupply,
      top1Percent: percentOfSupply(top1, totalSupply),
      top10Percent: percentOfSupply(top10, totalSupply),
      holderCount,
      logScanComplete: true, // getTokenLargestAccounts is a direct snapshot, not an incremental scan — never partial the way the EVM chunked log scan can be.
    };
  } catch (err) {
    logger.warn({ mintAddress, err: String(err) }, "solana holder snapshot failed");
    return undefined;
  }
}
