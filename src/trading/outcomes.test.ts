import { describe, expect, it } from "vitest";
import { detectionMismatch, outcomePollOrder, relabelOutcome, type OutcomeLabelsInput } from "./outcomes";

const created = new Date("2026-09-16T18:33:00Z");
const at = (minutes: number, mcap: number) => ({ capturedAt: new Date(created.getTime() + minutes * 60_000), marketCapUsd: mcap });

// XPAY, 2026-09-16: decided at a $138K pool mcap, first polled 54 minutes
// later after a rug at ~$1.8K, then bounced to ~$70K: recorded as a 38x.
const xpay: OutcomeLabelsInput = {
  marketCapAtDetection: 1_846,
  maxMarketCap15m: null,
  maxMarketCap1h: 1_900,
  maxMarketCap6h: 70_000,
  maxMarketCap24h: 70_000,
  maxMarketCap48h: 70_000,
  minMarketCap15m: null,
  minMarketCap1h: 1_800,
  minMarketCap6h: 1_800,
  minMarketCap24h: 1_800,
  minMarketCap48h: 1_800,
  feasibleMaxMultiple24h: 38.26,
  feasibleMaxMultiple48h: 38.26,
};
const snapshots = [at(-0.5, 138_000), at(3, 152_000), at(20, 40_000), at(54, 1_846), at(300, 70_000), at(2_000, 30_000)];

describe("detectionMismatch", () => {
  it("flags a detection mcap more than 5x off the decision-time mcap, either way", () => {
    expect(detectionMismatch(1_846, 138_000)).toBe(true);
    expect(detectionMismatch(800_000, 138_000)).toBe(true);
    expect(detectionMismatch(120_000, 138_000)).toBe(false);
    expect(detectionMismatch(1_846, undefined)).toBe(false);
    expect(detectionMismatch(null, 138_000)).toBe(false);
  });
});

describe("relabelOutcome", () => {
  const out = relabelOutcome(xpay, 138_000, created, snapshots);

  it("re-bases multiples, drawdown and hits on the decision-time mcap", () => {
    expect(out.marketCapAtDetection).toBe(138_000);
    expect(out.maxMarketCap24h).toBe(152_000); // the real peak, 3 minutes in
    expect(out.maxMultiple24h).toBeCloseTo(152 / 138);
    expect(out.maxDrawdown24h).toBeCloseTo(((1_846 - 138_000) / 138_000) * 100);
    expect(out.hit125x).toBe(false);
    expect(out.hit200x).toBe(false);
    expect(out.hit1000x).toBe(false);
  });

  it("rescales the feasible peak it can't re-probe, and drops the fake feasible hits", () => {
    expect(out.feasibleMaxMultiple24h).toBeCloseTo(38.26 * (1_846 / 138_000));
    expect(out.feasibleHit200x).toBe(false);
    expect(out.feasibleHit500x).toBe(false);
  });

  it("recomputes windows and time-to-hit from the snapshot history", () => {
    expect(out.maxMarketCap15m).toBe(152_000);
    expect(out.minMarketCap1h).toBe(1_846);
    expect(out.timeTo150xMinutes).toBeNull();
    const pump = relabelOutcome({ ...xpay, marketCapAtDetection: 30_000 }, 20_000, created, [at(0, 20_000), at(10, 31_000), at(45, 60_000)]);
    expect(pump.timeTo150xMinutes).toBe(10);
    expect(pump.timeTo250xMinutes).toBe(45);
    expect(pump.hit250x).toBe(true);
    expect(pump.hit500x).toBe(false);
  });

  it("keeps the stored window when no snapshot covers it", () => {
    const sparse = relabelOutcome(xpay, 138_000, created, [at(300, 70_000)]);
    expect(sparse.maxMarketCap1h).toBe(1_900);
    expect(sparse.maxMarketCap24h).toBe(70_000);
  });

  it("is idempotent: re-basing on the same mcap changes nothing further", () => {
    const again = relabelOutcome({ ...xpay, ...out, marketCapAtDetection: 138_000 } as OutcomeLabelsInput, 138_000, created, snapshots);
    expect(again.feasibleMaxMultiple24h).toBeCloseTo(out.feasibleMaxMultiple24h!);
    expect(again.maxMultiple24h).toBeCloseTo(out.maxMultiple24h!);
  });
});

describe("outcomePollOrder", () => {
  it("polls never-polled candidates first, newest first, then the stalest", () => {
    const c = (id: string, createdMin: number, updatedMin?: number) => ({
      id,
      createdAt: new Date(created.getTime() + createdMin * 60_000),
      outcome: updatedMin === undefined ? null : { updatedAt: new Date(created.getTime() + updatedMin * 60_000) },
    });
    const order = outcomePollOrder([c("old-fresh", 0, 50), c("new-a", 30), c("old-stale", 5, 10), c("new-b", 40)]).map((x) => x.id);
    expect(order).toEqual(["new-b", "new-a", "old-stale", "old-fresh"]);
  });
});
