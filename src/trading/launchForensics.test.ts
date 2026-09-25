import { describe, it, expect } from "vitest";
import {
  computeCreatorHolding,
  computeEarlyBuyerFeatures,
  computeFundingLinks,
  evaluateLaunchForensics,
  summarizeCreatorLaunches,
  type LaunchForensics,
  type LaunchForensicsThresholds,
  type LaunchTx,
  type WalletFunding,
} from "./launchForensics";

const SUPPLY = 1_000_000n;
const POOL = "pool-vault-authority";

function buy(signature: string, slot: number, wallet: string, amount: bigint): LaunchTx {
  return {
    signature,
    slot,
    blockTime: 1_000 + slot,
    feePayer: wallet,
    moves: [
      { owner: wallet, delta: amount, ownerIsProgram: false },
      { owner: POOL, delta: -amount, ownerIsProgram: true },
    ],
  };
}

function launch(creator: string, devBuy: bigint, slot = 100): LaunchTx {
  return {
    signature: "launch",
    slot,
    blockTime: 1_000 + slot,
    feePayer: creator,
    moves: [
      ...(devBuy > 0n ? [{ owner: creator, delta: devBuy, post: devBuy, ownerIsProgram: false }] : []),
      { owner: POOL, delta: SUPPLY - devBuy, ownerIsProgram: true },
    ],
  };
}

describe("computeEarlyBuyerFeatures", () => {
  it("counts block-0 buyers as a launch bundle and sums the first-20 share", () => {
    const txs = [
      launch("dev", 50_000n),
      buy("b1", 100, "w1", 100_000n),
      buy("b2", 100, "w2", 100_000n),
      buy("b3", 101, "w3", 10_000n),
      buy("b4", 105, "w4", 10_000n),
    ];
    const f = computeEarlyBuyerFeatures(txs, SUPPLY)!;
    expect(f.creator).toBe("dev");
    expect(f.creatorInitialBuyPct).toBe(5);
    expect(f.buyersSeen).toBe(4);
    expect(f.launchSlotBuyerCount).toBe(2);
    expect(f.launchSlotBuySharePct).toBe(20);
    expect(f.first20BuyerSharePct).toBe(22);
    // w1 and w2 share the launch slot; w3 and w4 are alone in theirs.
    expect(f.sameSlotBuyerCount).toBe(2);
    expect(f.sameSlotBuySharePct).toBe(20);
  });

  it("caps the first-N shares at the first 10 and 20 distinct buyers, in order", () => {
    const txs = [launch("dev", 0n), ...Array.from({ length: 25 }, (_, i) => buy(`b${i}`, 200 + i, `w${i}`, 10_000n))];
    const f = computeEarlyBuyerFeatures(txs, SUPPLY)!;
    expect(f.buyersSeen).toBe(25);
    expect(f.first10BuyerSharePct).toBe(10);
    expect(f.first20BuyerSharePct).toBe(20);
    expect(f.firstBuyers.map((b) => b.wallet)).toEqual(Array.from({ length: 20 }, (_, i) => `w${i}`));
  });

  it("adds up repeat buys by the same wallet and counts a wallet once", () => {
    const txs = [launch("dev", 0n), buy("b1", 101, "w1", 10_000n), buy("b2", 102, "w1", 30_000n)];
    const f = computeEarlyBuyerFeatures(txs, SUPPLY)!;
    expect(f.buyersSeen).toBe(1);
    expect(f.first10BuyerSharePct).toBe(4);
  });

  it("treats the pump.fun curve creator as an insider, not a buyer", () => {
    // Deployer pays for the launch; the curve records a different creator
    // wallet that then buys in the next slot.
    const txs = [launch("deployer", 100_000n), buy("b1", 101, "curveCreator", 50_000n), buy("b2", 101, "w1", 10_000n)];
    const f = computeEarlyBuyerFeatures(txs, SUPPLY, ["curveCreator"])!;
    expect(f.creator).toBe("deployer");
    expect(f.creatorInitialBuyPct).toBe(10);
    expect(f.buyersSeen).toBe(1);
    expect(f.firstBuyers[0].wallet).toBe("w1");
  });

  it("never counts program-owned accounts (pools, curves) as buyers", () => {
    const txs = [launch("dev", 0n), { signature: "x", slot: 101, feePayer: "w1", moves: [{ owner: "otherPool", delta: 5n, ownerIsProgram: true }] }];
    expect(computeEarlyBuyerFeatures(txs, SUPPLY)!.buyersSeen).toBe(0);
  });

  it("returns undefined with nothing to read", () => {
    expect(computeEarlyBuyerFeatures([], SUPPLY)).toBeUndefined();
    expect(computeEarlyBuyerFeatures([launch("dev", 0n)], 0n)).toBeUndefined();
  });
});

describe("computeCreatorHolding", () => {
  const sell = (sig: string, post: bigint, delta: bigint): LaunchTx => ({ signature: sig, slot: 200, feePayer: "dev", moves: [{ owner: "dev", delta, post, ownerIsProgram: false }] });

  it("tracks the dev buy, then sells, as a share of the peak", () => {
    const h = computeCreatorHolding([launch("dev", 100_000n), sell("s1", 40_000n, -60_000n), sell("s2", 25_000n, -15_000n)], "dev", SUPPLY);
    expect(h.peakPct).toBe(10);
    expect(h.currentPct).toBe(2.5);
    expect(h.soldPctOfPeak).toBe(75);
    expect(h.sellTxCount).toBe(2);
  });

  it("reports nothing sold when the creator never held any", () => {
    const h = computeCreatorHolding([launch("dev", 0n)], "dev", SUPPLY);
    expect(h).toEqual({ peakPct: 0, currentPct: 0, soldPctOfPeak: 0, sellTxCount: 0 });
  });

  it("takes post balances as absolute, so a window missing older transactions still gets the current holding", () => {
    const h = computeCreatorHolding([sell("s9", 10_000n, -5_000n)], "dev", SUPPLY);
    expect(h.currentPct).toBe(1);
  });
});

describe("summarizeCreatorLaunches", () => {
  const now = 100 * 3600;
  it("counts only launches before this one, and calls unfinished ones 6h+ old dead", () => {
    const s = summarizeCreatorLaunches(
      [
        { launchTime: now - 48 * 3600, graduated: false },
        { launchTime: now - 10 * 3600, graduated: true },
        { launchTime: now - 2 * 3600, graduated: false },
        { launchTime: now + 3600, graduated: false },
      ],
      now
    );
    expect(s).toEqual({ priorLaunches: 3, priorGraduated: 1, priorDead: 1, launchesPrior24h: 2 });
  });
});

describe("computeFundingLinks", () => {
  const buyers = ["a", "b", "c", "d"].map((w, i) => ({ wallet: w, slot: 100 + i, signature: `s${i}`, acquired: 50_000n }));
  const funding = (pairs: [string, string | undefined][]) => new Map<string, WalletFunding>(pairs.map(([w, f]) => [w, { wallet: w, funder: f }]));

  it("links buyers funded by the creator or by the creator's own funder", () => {
    const f = computeFundingLinks(buyers, ["dev"], { wallet: "dev", funder: "mom" }, funding([["a", "dev"], ["b", "mom"], ["c", "cex"], ["d", undefined]]), new Set(["cex"]), SUPPLY);
    expect(f.creatorLinkedBuyers).toBe(2);
    expect(f.creatorLinkedSharePct).toBe(10);
    expect(f.buyersWithKnownFunder).toBe(3);
  });

  it("finds clusters of buyers sharing one funder, but never through a busy wallet", () => {
    const f = computeFundingLinks(buyers, ["dev"], undefined, funding([["a", "x"], ["b", "x"], ["c", "cex"], ["d", "cex"]]), new Set(["cex"]), SUPPLY);
    expect(f.largestFunderCluster).toBe(2);
    expect(f.clusteredBuyerSharePct).toBe(10);
    expect(f.creatorLinkedBuyers).toBe(0);
  });

  it("reports no links when no funder could be read", () => {
    const f = computeFundingLinks(buyers, ["dev"], undefined, new Map(), new Set(), SUPPLY);
    expect(f).toEqual({ creatorLinkedBuyers: 0, creatorLinkedSharePct: 0, largestFunderCluster: 0, clusteredBuyerSharePct: 0, buyersWithKnownFunder: 0 });
  });
});

describe("evaluateLaunchForensics", () => {
  const thresholds: LaunchForensicsThresholds = {
    maxFirst20BuyerSharePct: 60,
    maxLaunchSlotBuySharePct: 30,
    maxCreatorSoldPctOfPeak: 90,
    maxCreatorPriorDeadLaunches: 5,
    maxLinkedBuyerSharePct: 10,
  };
  const base = (over: Partial<LaunchForensics>): LaunchForensics => ({ chain: "solana", token: "t", asOf: "2026-09-25T00:00:00Z", launchpad: "pumpfun", unknowns: [], ...over });
  const early = {
    creatorInitialBuyPct: 0,
    buyersSeen: 20,
    first10BuyerSharePct: 20,
    first20BuyerSharePct: 30,
    launchSlotBuyerCount: 1,
    launchSlotBuySharePct: 5,
    sameSlotBuyerCount: 2,
    sameSlotBuySharePct: 6,
  };

  it("passes when forensics couldn't be read at all (UNKNOWN is not a penalty)", () => {
    expect(evaluateLaunchForensics(undefined, thresholds).passed).toBe(true);
  });

  it("passes when every feature group is missing", () => {
    const v = evaluateLaunchForensics(base({ unknowns: ["early buyers: launch is more than 10000 transactions back", "funding: timeout"] }), thresholds);
    expect(v).toEqual({ passed: true, failedChecks: [], reasons: [] });
  });

  it("passes a clean launch", () => {
    const v = evaluateLaunchForensics(
      base({ early, creatorHolding: { peakPct: 5, currentPct: 5, soldPctOfPeak: 0, sellTxCount: 0 }, creatorLaunches: { priorLaunches: 1, priorGraduated: 1, priorDead: 0, launchesPrior24h: 0 } }),
      thresholds
    );
    expect(v.passed).toBe(true);
  });

  it("blocks on each piece of positive evidence", () => {
    const v = evaluateLaunchForensics(
      base({
        early: { ...early, first20BuyerSharePct: 70, launchSlotBuySharePct: 35, launchSlotBuyerCount: 8 },
        creatorHolding: { peakPct: 10, currentPct: 0, soldPctOfPeak: 100, sellTxCount: 3 },
        creatorLaunches: { priorLaunches: 25, priorGraduated: 1, priorDead: 24, launchesPrior24h: 3 },
        funding: { creatorLinkedBuyers: 3, creatorLinkedSharePct: 12, largestFunderCluster: 1, clusteredBuyerSharePct: 0, buyersWithKnownFunder: 5 },
      }),
      thresholds
    );
    expect(v.passed).toBe(false);
    expect(v.failedChecks).toEqual(["firstBuyersShare", "launchBlockBundle", "creatorSelling", "serialLauncher", "linkedBuyers"]);
    expect(v.reasons).toHaveLength(5);
  });

  it("never calls a creator that held nothing a seller", () => {
    const v = evaluateLaunchForensics(base({ creatorHolding: { peakPct: 0, currentPct: 0, soldPctOfPeak: 100, sellTxCount: 0 } }), thresholds);
    expect(v.passed).toBe(true);
  });

  it("treats a 0 threshold as off", () => {
    const off: LaunchForensicsThresholds = { maxFirst20BuyerSharePct: 0, maxLaunchSlotBuySharePct: 0, maxCreatorSoldPctOfPeak: 0, maxCreatorPriorDeadLaunches: 0, maxLinkedBuyerSharePct: 0 };
    const v = evaluateLaunchForensics(
      base({ early: { ...early, first20BuyerSharePct: 99, launchSlotBuySharePct: 99 }, creatorLaunches: { priorLaunches: 99, priorGraduated: 0, priorDead: 99, launchesPrior24h: 99 } }),
      off
    );
    expect(v.passed).toBe(true);
  });
});
