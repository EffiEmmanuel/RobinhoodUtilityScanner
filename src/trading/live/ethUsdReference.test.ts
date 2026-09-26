import { describe, it, expect, vi } from "vitest";

const getLogs = vi.fn(async () => {
  throw new Error("getLogs must not be called for the ETH/USD rate");
});
// USDG out for 0.01 ETH, per pinned pool (by fee).
const usdgOutByFee: Record<number, bigint | Error> = { [0x800000]: 26_768_324n, 100: 26_781_245n, 460: 26_758_870n };
const simulateContract = vi.fn(async ({ args }: { args: [{ poolKey: { fee: number } }] }) => {
  const out = usdgOutByFee[args[0].poolKey.fee];
  if (out instanceof Error) throw out;
  return { result: [out, 100_000n] };
});
vi.mock("./wallet", () => ({
  getPublicClient: () => ({ getLogs, simulateContract }),
  getWalletAddress: vi.fn(),
  signAndSendTransaction: vi.fn(),
  isWalletConfigured: vi.fn(() => true),
}));

import { quoteEthPriceUsd, medianPlausibleEthRate, ETH_USD_REFERENCE_POOLS } from "./liveExecutionProvider";
import { computePoolId } from "./routing";

describe("ETH_USD_REFERENCE_POOLS", () => {
  it("are the on-chain pools they claim to be", () => {
    // Pool ids from their Initialize events (2026-09-25).
    expect(ETH_USD_REFERENCE_POOLS.map(computePoolId)).toEqual([
      "0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551",
      "0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e",
      "0x54f7883914619af9105355bf83ed678bcf9f63560218ac61c9963b9503d0ba32",
    ]);
  });
});

describe("quoteEthPriceUsd", () => {
  it("quotes the pinned pools and takes the median, with no log scan", async () => {
    const rate = await quoteEthPriceUsd();
    expect(rate).toBeCloseTo(2676.8324, 3);
    expect(getLogs).not.toHaveBeenCalled();
    expect(simulateContract).toHaveBeenCalledTimes(3);
  });

  it("still returns a rate when a pool fails to quote", async () => {
    usdgOutByFee[0x800000] = new Error("hook reverted");
    try {
      expect(await quoteEthPriceUsd()).toBeCloseTo((2678.1245 + 2675.887) / 2, 3);
    } finally {
      usdgOutByFee[0x800000] = 26_768_324n;
    }
  });
});

describe("medianPlausibleEthRate", () => {
  it("takes the median of the plausible rates", () => {
    expect(medianPlausibleEthRate([2676, 2600, 2700])).toBe(2676);
    expect(medianPlausibleEthRate([2676, 2600])).toBe(2638);
  });

  it("ignores a drained pool's rate and failed quotes, and gives up with none left", () => {
    expect(medianPlausibleEthRate([2676, 3, undefined, 2680])).toBe(2678);
    expect(medianPlausibleEthRate([undefined, 50])).toBeUndefined();
  });
});
