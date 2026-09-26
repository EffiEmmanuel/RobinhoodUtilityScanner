import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const v4PoolKey = { findUnique: vi.fn(), upsert: vi.fn(async () => undefined) };
const directEthPool = { findUnique: vi.fn(), upsert: vi.fn(async () => undefined) };
vi.mock("../../db", () => ({ db: { v4PoolKey, directEthPool } }));

const key = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0x00000000000000000000000000000000000000aa", fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" } as const;

describe("poolKeyStore", () => {
  let store: typeof import("./poolKeyStore");
  beforeAll(async () => {
    vi.stubEnv("VITEST", "");
    vi.resetModules();
    store = await import("./poolKeyStore");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("reads a stored pool key back", async () => {
    v4PoolKey.findUnique.mockResolvedValueOnce({ poolId: "0xabc", ...key });
    expect(await store.loadPoolKey("0xABC")).toEqual(key);
    expect(v4PoolKey.findUnique).toHaveBeenCalledWith({ where: { poolId: "0xabc" } });
  });

  it("treats a failed read as a miss", async () => {
    v4PoolKey.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await store.loadPoolKey("0xabc")).toBeUndefined();
  });

  it("stores a key without ever overwriting one (a pool key never changes)", async () => {
    store.savePoolKey("0xDEF", key);
    await vi.waitFor(() => expect(v4PoolKey.upsert).toHaveBeenCalled());
    expect(v4PoolKey.upsert).toHaveBeenCalledWith({ where: { poolId: "0xdef" }, create: { poolId: "0xdef", ...key }, update: {} });
  });

  it("round-trips a token's direct pool choice, per entry/exit mode", async () => {
    store.saveDirectEthPool("0xAA", true, { poolKey: key, poolId: "0xP1", initializedAtBlock: 42n });
    await vi.waitFor(() => expect(directEthPool.upsert).toHaveBeenCalled());
    const call = (directEthPool.upsert.mock.calls[0] as unknown as [{ where: unknown; create: Record<string, unknown> }])[0];
    expect(call.where).toEqual({ tokenAddress_allowHighFeePools: { tokenAddress: "0xaa", allowHighFeePools: true } });
    expect(call.create).toMatchObject({ poolId: "0xp1", initializedAtBlock: 42n, fee: 3000 });

    directEthPool.findUnique.mockResolvedValueOnce({ tokenAddress: "0xaa", allowHighFeePools: true, poolId: "0xp1", ...key, initializedAtBlock: 42n });
    expect(await store.loadDirectEthPool("0xAA", true)).toEqual({ poolKey: key, poolId: "0xp1", initializedAtBlock: 42n });
  });
});

describe("poolKeyStore under vitest", () => {
  it("stays out of the database entirely", async () => {
    vi.resetModules();
    const inert = await import("./poolKeyStore");
    v4PoolKey.findUnique.mockClear();
    expect(await inert.loadPoolKey("0xabc")).toBeUndefined();
    expect(v4PoolKey.findUnique).not.toHaveBeenCalled();
  });
});
