import { describe, it, expect, vi, beforeEach } from "vitest";

const loadDirectEthPool = vi.fn();
const saveDirectEthPool = vi.fn();
vi.mock("./poolKeyStore", () => ({
  loadDirectEthPool: (...a: unknown[]) => loadDirectEthPool(...a),
  saveDirectEthPool: (...a: unknown[]) => saveDirectEthPool(...a),
}));

import type { PublicClient } from "viem";
import { discoverPool } from "./poolDiscovery";

const stored = {
  poolKey: { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x00000000000000000000000000000000000000aa", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" },
  poolId: "0x1111111111111111111111111111111111111111111111111111111111111111",
} as const;

function client(liquidity: bigint) {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => (functionName === "getSlot0" ? [0n, 0, 0, 0] : liquidity)),
    getLogs: vi.fn(async () => []),
    getBlockNumber: vi.fn(async () => 1_000n),
  };
}

let n = 0x100;
const token = () => `0x${(++n).toString(16).padStart(40, "0")}` as `0x${string}`;

describe("discoverPool across restarts", () => {
  beforeEach(() => {
    loadDirectEthPool.mockReset();
    saveDirectEthPool.mockReset();
  });

  it("uses the pool an earlier process settled on, with no log scan", async () => {
    loadDirectEthPool.mockResolvedValue(stored);
    const c = client(5_000n);
    const pool = await discoverPool(c as unknown as PublicClient, token());
    expect(pool).toMatchObject({ poolId: stored.poolId, liquidity: 5_000n });
    expect(c.getLogs).not.toHaveBeenCalled();
  });

  it("drops a stored pool that has been drained and looks again", async () => {
    loadDirectEthPool.mockResolvedValue(stored);
    const c = client(0n);
    await discoverPool(c as unknown as PublicClient, token());
    expect(c.getLogs).toHaveBeenCalled();
  });
});
