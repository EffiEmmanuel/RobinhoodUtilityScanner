import { logger } from "../../logger";
import type { PoolKey } from "./poolDiscovery";

/**
 * Uniswap v4 pool keys found on-chain, kept across restarts (2026-09-26).
 * A deploy used to forget every one, and finding them again meant
 * re-scanning PoolManager's Initialize logs for every candidate and open
 * position at once — which the RPC rate-limited (49 cooldowns across 9
 * tokens in the 47 minutes after one restart). A pool's key never changes
 * once it's initialized.
 *
 * Best-effort both ways: a read or write that fails is only a cache miss.
 * Inert under vitest, so no unit test can reach a database.
 */
const enabled = !process.env.VITEST;

async function database() {
  return (await import("../../db")).db;
}

export async function loadPoolKey(poolId: string): Promise<PoolKey | undefined> {
  if (!enabled) return undefined;
  try {
    const row = await (await database()).v4PoolKey.findUnique({ where: { poolId: poolId.toLowerCase() } });
    return row ? toPoolKey(row) : undefined;
  } catch (err) {
    logger.debug({ poolId, err: String(err) }, "stored pool key read failed — looking it up on-chain");
    return undefined;
  }
}

export function savePoolKey(poolId: string, key: PoolKey): void {
  if (!enabled) return;
  const data = { poolId: poolId.toLowerCase(), ...fromPoolKey(key) };
  void database()
    .then((db) => db.v4PoolKey.upsert({ where: { poolId: data.poolId }, create: data, update: {} }))
    .catch((err) => logger.debug({ poolId, err: String(err) }, "storing a pool key failed"));
}

export interface StoredDirectPool {
  poolKey: PoolKey;
  poolId: `0x${string}`;
  initializedAtBlock?: bigint;
}

export async function loadDirectEthPool(tokenAddress: string, allowHighFeePools: boolean): Promise<StoredDirectPool | undefined> {
  if (!enabled) return undefined;
  try {
    const row = await (await database()).directEthPool.findUnique({
      where: { tokenAddress_allowHighFeePools: { tokenAddress: tokenAddress.toLowerCase(), allowHighFeePools } },
    });
    if (!row) return undefined;
    return { poolKey: toPoolKey(row), poolId: row.poolId as `0x${string}`, initializedAtBlock: row.initializedAtBlock ?? undefined };
  } catch (err) {
    logger.debug({ tokenAddress, err: String(err) }, "stored direct pool read failed — discovering it on-chain");
    return undefined;
  }
}

export function saveDirectEthPool(tokenAddress: string, allowHighFeePools: boolean, pool: StoredDirectPool): void {
  if (!enabled) return;
  const id = { tokenAddress: tokenAddress.toLowerCase(), allowHighFeePools };
  const data = { poolId: pool.poolId.toLowerCase(), ...fromPoolKey(pool.poolKey), initializedAtBlock: pool.initializedAtBlock ?? null };
  void database()
    .then((db) => db.directEthPool.upsert({ where: { tokenAddress_allowHighFeePools: id }, create: { ...id, ...data }, update: data }))
    .catch((err) => logger.debug({ tokenAddress, err: String(err) }, "storing a direct pool failed"));
}

function toPoolKey(row: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): PoolKey {
  return {
    currency0: row.currency0 as `0x${string}`,
    currency1: row.currency1 as `0x${string}`,
    fee: row.fee,
    tickSpacing: row.tickSpacing,
    hooks: row.hooks as `0x${string}`,
  };
}

function fromPoolKey(key: PoolKey) {
  return { currency0: key.currency0, currency1: key.currency1, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks };
}
