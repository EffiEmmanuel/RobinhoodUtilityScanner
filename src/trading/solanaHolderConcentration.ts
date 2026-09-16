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
 *    better RPC plan." On failure this falls back to counting only the
 *    top-10 largest accounts (from getTokenLargestAccounts, which is
 *    reliable) — an undercount, which again only makes minHolderCount fail
 *    harder, never laxer.
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
// providers offer, at the cost of one extra round-trip per 10 top holders —
// negligible next to the RPC calls this function already makes.
const MAX_ACCOUNTS_PER_BATCH = 5;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function bestEffortHolderCount(conn: Connection, mint: PublicKey, fallback: number): Promise<number> {
  try {
    const [legacy, token2022] = await Promise.all([
      conn.getProgramAccounts(TOKEN_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }], dataSlice: { offset: 0, length: 0 } }),
      conn.getProgramAccounts(TOKEN_2022_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }], dataSlice: { offset: 0, length: 0 } }),
    ]);
    return legacy.length + token2022.length;
  } catch (err) {
    logger.warn({ mint: mint.toBase58(), err: String(err) }, "solana holder count scan unavailable (RPC provider commonly excludes the Token program from secondary indexes) — falling back to top-10-only count");
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

    const topAccounts = largestResp.value.slice(0, 10);
    if (topAccounts.length === 0) return undefined;

    // Resolve each top account's owning wallet/authority, then check whether
    // THAT authority is itself a PDA controlled by a known pool program —
    // a pool's vault token account is "owned" (in the SPL sense) by a
    // program-derived address, not a human wallet. Batched at
    // MAX_ACCOUNTS_PER_BATCH to stay within free-tier RPC limits.
    const parsedBatches = await Promise.all(chunk(topAccounts, MAX_ACCOUNTS_PER_BATCH).map((batch) => conn.getMultipleParsedAccounts(batch.map((a) => a.address))));
    const parsedAccounts = parsedBatches.flatMap((batch) => batch.value);
    const ownerPubkeys = parsedAccounts.map((acc) => {
      const data = acc?.data;
      if (!data || !("parsed" in data)) return undefined;
      const owner = (data.parsed as { info?: { owner?: string } })?.info?.owner;
      return owner ? new PublicKey(owner) : undefined;
    });
    const ownerBatches = await Promise.all(
      chunk(
        ownerPubkeys.map((pk) => pk ?? PublicKey.default),
        MAX_ACCOUNTS_PER_BATCH
      ).map((batch) => conn.getMultipleAccountsInfo(batch))
    );
    const ownerAccountInfos = ownerBatches.flat();

    const holders = topAccounts.map((acct, i) => {
      const ownerProgram = ownerAccountInfos[i]?.owner.toBase58();
      const isPool = ownerProgram !== undefined && KNOWN_POOL_PROGRAM_IDS.has(ownerProgram);
      return { balance: BigInt(acct.amount), isPool };
    });

    const ranked = holders
      .filter((h) => !h.isPool && h.balance > 0n)
      .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));

    const top1 = ranked.slice(0, 1).reduce((sum, h) => sum + h.balance, 0n);
    const top10 = ranked.slice(0, 10).reduce((sum, h) => sum + h.balance, 0n);
    const holderCount = await bestEffortHolderCount(conn, mint, ranked.length);

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
