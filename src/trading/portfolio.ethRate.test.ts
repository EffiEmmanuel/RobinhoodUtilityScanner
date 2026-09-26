import { describe, it, expect, vi } from "vitest";

vi.mock("./live/liveExecutionProvider", () => ({
  quoteEthPriceUsd: vi.fn(async () => 2676),
  isLiveModeReady: vi.fn(() => false),
  getWalletGasBalanceEth: vi.fn(),
}));

import { getEthPriceUsd, getCachedEthPriceUsd, ETH_PRICE_CACHE_MAX_AGE_MS, noteCashOmitted } from "./portfolio";
import { logger } from "../logger";

describe("cached ETH/USD rate", () => {
  it("stands in for a fresh one for up to 15 minutes, then is withheld", async () => {
    const start = Date.now();
    expect(await getEthPriceUsd()).toBe(2676);
    expect(ETH_PRICE_CACHE_MAX_AGE_MS).toBe(15 * 60_000);
    expect(getCachedEthPriceUsd(start + 14 * 60_000)).toBe(2676);
    expect(getCachedEthPriceUsd(start + 16 * 60_000)).toBeUndefined();
  });
});

describe("noteCashOmitted", () => {
  it("logs once when a wallet's cash starts being left out and once when it's back", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
    for (let i = 0; i < 5; i++) noteCashOmitted("robinhood", true);
    expect(warn).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) noteCashOmitted("robinhood", false);
    expect(info).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    info.mockRestore();
  });
});
