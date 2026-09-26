import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const rankedRouteQuotes = vi.fn();
vi.mock("./routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./routing")>()),
  rankedRouteQuotes: (...args: unknown[]) => rankedRouteQuotes(...args),
}));
vi.mock("./wallet", () => ({
  getPublicClient: () => ({}),
  getWalletAddress: vi.fn(),
  signAndSendTransaction: vi.fn(),
  isWalletConfigured: vi.fn(() => true),
}));

import { getLiveQuotes } from "./liveExecutionProvider";

const route = { route: { pools: [{ poolKey: { currency0: "0x0", currency1: "0xa", fee: 3000, tickSpacing: 60, hooks: "0x0" }, poolId: "0x1" }], hubs: [] }, amountOut: 5n, gasEstimateUnits: 1n };
let n = 0;
const token = () => `0x${(++n).toString(16).padStart(40, "0")}` as `0x${string}`;

describe("no-route cache", () => {
  beforeEach(() => {
    rankedRouteQuotes.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("answers a repeat sell estimate for a routeless token without searching again", async () => {
    const t = token();
    rankedRouteQuotes.mockResolvedValue([]);
    expect(await getLiveQuotes(t, false, 1n, { allowHighFeePools: true })).toEqual([]);
    expect(await getLiveQuotes(t, false, 1n, { allowHighFeePools: true })).toEqual([]);
    expect(rankedRouteQuotes).toHaveBeenCalledTimes(1);
  });

  it("always searches for a buy quote and for an actual sell", async () => {
    const t = token();
    rankedRouteQuotes.mockResolvedValue([]);
    await getLiveQuotes(t, false, 1n);
    await getLiveQuotes(t, true, 1n);
    await getLiveQuotes(t, false, 1n, { allowHighFeePools: true, fresh: true });
    expect(rankedRouteQuotes).toHaveBeenCalledTimes(3);
  });

  it("searches again after 15 minutes, and forgets the token once a route shows up", async () => {
    const t = token();
    rankedRouteQuotes.mockResolvedValue([]);
    await getLiveQuotes(t, false, 1n);
    vi.advanceTimersByTime(15 * 60_000);
    await getLiveQuotes(t, false, 1n);
    expect(rankedRouteQuotes).toHaveBeenCalledTimes(2);

    rankedRouteQuotes.mockResolvedValue([route]);
    expect(await getLiveQuotes(t, true, 1n)).toHaveLength(1); // a buy finds the new pool
    await getLiveQuotes(t, false, 1n);
    expect(rankedRouteQuotes).toHaveBeenCalledTimes(4);
  });

  it("never caches an RPC failure as 'no route'", async () => {
    const t = token();
    rankedRouteQuotes.mockRejectedValueOnce(new Error("pool discovery inconclusive"));
    await expect(getLiveQuotes(t, false, 1n)).rejects.toThrow();
    rankedRouteQuotes.mockResolvedValue([route]);
    expect(await getLiveQuotes(t, false, 1n)).toHaveLength(1);
  });
});
