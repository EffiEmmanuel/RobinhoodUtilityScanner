import { describe, it, expect } from "vitest";
import type { PublicClient } from "viem";
import {
  evaluateHolderConcentration,
  getHolderSnapshot,
  logQueryLimitKind,
  type HolderSnapshot,
  type HolderConcentrationThresholds,
} from "./holderConcentration";

describe("evaluateHolderConcentration", () => {
  const thresholds: HolderConcentrationThresholds = { maxTop1HolderPercent: 15, maxTop10HolderPercent: 50, minHolderCount: 15 };

  const snapshot = (overrides: Partial<HolderSnapshot>): HolderSnapshot => ({
    totalSupply: 1_000_000n,
    top1Percent: 5,
    top10Percent: 20,
    holderCount: 40,
    logScanComplete: true,
    ...overrides,
  });

  it("passes a well-distributed token", () => {
    expect(evaluateHolderConcentration(snapshot({}), thresholds).passed).toBe(true);
  });

  it("fails closed with no snapshot at all (RPC/infra failure)", () => {
    const result = evaluateHolderConcentration(undefined, thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toEqual(["holderData"]);
    expect(result.reasons).toEqual(["holder data unavailable (RPC)"]);
  });

  it("blocks a single wallet holding enough supply to tank price alone", () => {
    const result = evaluateHolderConcentration(snapshot({ top1Percent: 40 }), thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("top1Holder");
  });

  it("blocks the top 10 holders controlling most of supply", () => {
    const result = evaluateHolderConcentration(snapshot({ top10Percent: 70 }), thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("top10Holders");
  });

  it("blocks too few distinct holders even if concentration percentages look fine", () => {
    const result = evaluateHolderConcentration(snapshot({ holderCount: 3, top1Percent: 10, top10Percent: 30 }), thresholds);
    expect(result.passed).toBe(false);
    expect(result.failedChecks).toContain("holderCount");
  });
});

// A simulated chain: Transfer logs at given blocks, and an RPC that refuses
// ranges or result sets past its caps with the real error text.
const ZERO = "0x0000000000000000000000000000000000000000";
const LATEST = 20_000_000n;
interface Transfer {
  block: bigint;
  from: string;
  to: string;
  value: bigint;
}
function chain(
  transfers: Transfer[],
  opts: { totalSupply: bigint; maxLogs?: number; maxRange?: bigint; failWith?: (from: bigint, to: bigint) => Error | undefined }
) {
  const calls: Array<[bigint, bigint]> = [];
  const client = {
    getBlockNumber: async () => LATEST,
    readContract: async () => opts.totalSupply,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push([fromBlock, toBlock]);
      const forced = opts.failWith?.(fromBlock, toBlock);
      if (forced) throw forced;
      if (opts.maxRange !== undefined && toBlock - fromBlock + 1n > opts.maxRange) {
        throw Object.assign(new Error("RPC Request failed."), { details: "ranges over 10000 blocks are not supported on freetier" });
      }
      const logs = transfers
        .filter((t) => t.block >= fromBlock && t.block <= toBlock)
        .map((t) => ({ args: { from: t.from, to: t.to, value: t.value } }));
      if (opts.maxLogs !== undefined && logs.length > opts.maxLogs) {
        throw Object.assign(new Error("RPC Request failed."), { details: "logs matched by query exceeds limit of 10000" });
      }
      return logs;
    },
  };
  return { client: client as unknown as PublicClient, calls };
}

const holder = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const TOKEN = "0x00000000000000000000000000000000000000aa";

// Minted to holder 1 at `mintBlock`, then 1 unit to each of `count` holders.
function launch(mintBlock: bigint, count: number, spreadBlocks: bigint): Transfer[] {
  const out: Transfer[] = [{ block: mintBlock, from: ZERO, to: holder(1), value: 1_000_000n }];
  for (let i = 0; i < count; i++) {
    out.push({ block: mintBlock + 1n + (BigInt(i) * spreadBlocks) / BigInt(Math.max(count, 1)), from: holder(1), to: holder(100 + i), value: 1_000n });
  }
  return out;
}

describe("getHolderSnapshot", () => {
  it("stops as soon as the whole minted supply is accounted for", async () => {
    const { client, calls } = chain(launch(LATEST - 1_000n, 30, 500n), { totalSupply: 1_000_000n });
    const snap = await getHolderSnapshot(client, TOKEN);
    expect(calls).toHaveLength(1);
    expect(snap).toMatchObject({ holderCount: 31, logScanComplete: true, top1Percent: 97 });
  });

  it("keeps going back past one span to reach an older mint, then stops", async () => {
    const { client, calls } = chain(launch(LATEST - 500_000n, 30, 400_000n), { totalSupply: 1_000_000n });
    const snap = await getHolderSnapshot(client, TOKEN);
    expect(calls).toHaveLength(2);
    expect(snap).toMatchObject({ holderCount: 31, logScanComplete: true });
  });

  it("splits a busy stretch that overflows the RPC's log cap and still gets every holder", async () => {
    // 600 transfers in 60,000 blocks against a 50-log cap: a 400K-block
    // call overflows, ~3,000-block calls don't.
    const { client, calls } = chain(launch(LATEST - 60_000n, 600, 60_000n), { totalSupply: 1_000_000n, maxLogs: 50 });
    const snap = await getHolderSnapshot(client, TOKEN);
    expect(snap).toMatchObject({ holderCount: 601, logScanComplete: true, top1Percent: 40 });
    expect(calls.length).toBeGreaterThan(10);
    expect(calls.length).toBeLessThan(120);
  });

  it("settles under a block-range cap instead of retrying wider ranges", async () => {
    const { client, calls } = chain(launch(LATEST - 200_000n, 20, 100_000n), { totalSupply: 1_000_000n, maxRange: 10_000n });
    const snap = await getHolderSnapshot(client, TOKEN);
    expect(snap).toMatchObject({ holderCount: 21, logScanComplete: true });
    const failed = calls.filter(([f, t]) => t - f + 1n > 10_000n).length;
    expect(failed).toBeLessThanOrEqual(6); // 400K halving down to 6,250, once
  });

  it("fails without splitting on a rate limit or network error", async () => {
    const tooMany = Object.assign(new Error("HTTP request failed. Status: 429"), { details: "Too Many Requests" });
    const { client, calls } = chain(launch(LATEST - 1_000n, 5, 500n), { totalSupply: 1_000_000n, failWith: () => tooMany });
    await expect(getHolderSnapshot(client, TOKEN)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it("fails once even the smallest range overflows", async () => {
    // 5,000 transfers inside 500 blocks against a 50-log cap.
    const { client } = chain(launch(LATEST - 500n, 5_000, 499n), { totalSupply: 10_000_000n, maxLogs: 50 });
    await expect(getHolderSnapshot(client, TOKEN)).rejects.toThrow("RPC Request failed");
  });
});

describe("logQueryLimitKind", () => {
  it.each([
    [{ details: "logs matched by query exceeds limit of 10000" }, "size"],
    [{ message: "query returned more than 10000 results" }, "size"],
    [{ details: "ranges over 10000 blocks are not supported on freetier" }, "range"],
    [{ message: "block range is too large" }, "range"],
    [{ message: "wrapped", cause: { details: "logs matched by query exceeds limit of 10000" } }, "size"],
    [{ details: "Too Many Requests", message: "Status: 429" }, undefined],
    [{ message: "fetch failed" }, undefined],
  ])("classifies %j", (err, kind) => {
    expect(logQueryLimitKind(err)).toBe(kind);
  });
});
