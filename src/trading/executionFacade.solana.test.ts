import { describe, it, expect, vi, beforeEach } from "vitest";

const provider = {
  isSolanaLiveModeReady: vi.fn(() => true),
  executeSolanaLiveBuy: vi.fn(),
  executeSolanaLiveSell: vi.fn(),
  closeEmptySolanaTokenAccount: vi.fn(),
};
vi.mock("./live/solana/executionProvider", () => ({
  isSolanaLiveModeReady: () => provider.isSolanaLiveModeReady(),
  executeSolanaLiveBuy: (...args: unknown[]) => provider.executeSolanaLiveBuy(...args),
  executeSolanaLiveSell: (...args: unknown[]) => provider.executeSolanaLiveSell(...args),
  closeEmptySolanaTokenAccount: (...args: unknown[]) => provider.closeEmptySolanaTokenAccount(...args),
  getSolanaLiveQuote: vi.fn(),
  canSolanaWalletTransferToken: vi.fn(),
}));
const balances = { before: 0n, after: 0n, current: 1_000_000n };
vi.mock("./live/solana/tokenUtils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./live/solana/tokenUtils")>()),
  getSolanaMintDecimals: vi.fn(async () => 6),
  getSolanaTokenBalance: vi.fn(async () => balances.current),
}));
vi.mock("./live/solana/wallet", () => ({
  getSolanaConnection: vi.fn(() => ({})),
  getSolanaWalletPublicKey: vi.fn(() => ({})),
}));
vi.mock("./portfolio", () => ({ getSolPriceUsd: vi.fn(async () => 100), getCachedEthPriceUsd: vi.fn(() => 2500) }));
vi.mock("./executionQuality", () => ({ recordExecutionQuality: vi.fn(async () => undefined) }));

import { executeSellFill, executeBuyFill, closeTokenAccountAfterFullExit, gasLedgerNote } from "./executionFacade";
import { getSolanaTokenBalance } from "./live/solana/tokenUtils";
import { tradeRealizedPnl } from "./pnl";
import type { MarketPair } from "../dex/types";

const MINT = "Mint111111111111111111111111111111111111111";
// Not SOL-quoted, so the price comes from the mocked getSolPriceUsd ($100/SOL).
const pair = { priceUsd: 0.001, quoteTokenAddress: "other" } as unknown as MarketPair;
const RENT = 1_513_840;

describe("Solana full exit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    balances.current = 1_000_000n;
    provider.executeSolanaLiveSell.mockResolvedValue({ signature: "sell", amountIn: 1_000_000n, amountOut: 20_000_000n, feeLamports: 5_000 });
  });

  it("sells a rounding-sized remainder so the token account ends up empty", async () => {
    await executeSellFill(MINT, 0.99995, pair, "solana", { fullExit: true });
    expect(provider.executeSolanaLiveSell).toHaveBeenCalledWith(MINT, 1_000_000n, expect.any(Number));
  });

  it("leaves the remainder on a partial sell", async () => {
    await executeSellFill(MINT, 0.99995, pair, "solana");
    expect(provider.executeSolanaLiveSell).toHaveBeenCalledWith(MINT, 999_950n, expect.any(Number));
  });

  it("never closes the account inside the sell itself", async () => {
    const fill = await executeSellFill(MINT, 1, pair, "solana", { fullExit: true });
    expect(provider.closeEmptySolanaTokenAccount).not.toHaveBeenCalled();
    expect(fill.gasCostUsd).toBeCloseTo((5_000 / 1e9) * 100, 9);
  });
});

describe("closeTokenAccountAfterFullExit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the refunded rent net of the close fee, to book against the sell", async () => {
    provider.closeEmptySolanaTokenAccount.mockResolvedValue({ status: "closed", signature: "close", refundLamports: RENT, feeLamports: 5_000 });
    const result = await closeTokenAccountAfterFullExit(MINT, pair, "solana");
    expect(provider.closeEmptySolanaTokenAccount).toHaveBeenCalledWith(MINT);
    expect(result?.gasCostUsd).toBeCloseTo(((5_000 - RENT) / 1e9) * 100, 9);
    expect(result?.receipt).toEqual({ closeSignature: "close", closeFeeLamports: 5_000, rentRefundLamports: RENT });
    expect(gasLedgerNote({ provider: "live", receipt: result?.receipt })).toContain("1513840 lamports rent refunded, 5000 lamports fee (close)");
  });

  it("never throws when the close fails; the rent stays a cost", async () => {
    provider.closeEmptySolanaTokenAccount.mockRejectedValue(new Error("rpc down"));
    const result = await closeTokenAccountAfterFullExit(MINT, pair, "solana");
    expect(result?.gasCostUsd).toBe(0);
    expect(result?.receipt.closeSkippedReason).toContain("rpc down");
  });

  it("records why a close was skipped", async () => {
    provider.closeEmptySolanaTokenAccount.mockResolvedValue({ status: "skipped", reason: "still holds 3 raw units" });
    const result = await closeTokenAccountAfterFullExit(MINT, pair, "solana");
    expect(result?.receipt.closeSkippedReason).toBe("still holds 3 raw units");
  });

  it("does nothing off Solana", async () => {
    expect(await closeTokenAccountAfterFullExit("0xabc", pair, "robinhood")).toBeUndefined();
    expect(provider.closeEmptySolanaTokenAccount).not.toHaveBeenCalled();
  });
});

describe("Solana buy that opens a token account", () => {
  it("books the account's rent as a cost of the buy", async () => {
    vi.mocked(getSolanaTokenBalance).mockResolvedValueOnce(0n).mockResolvedValueOnce(5_000_000n);
    provider.executeSolanaLiveBuy.mockResolvedValue({ signature: "buy", amountIn: 50_000_000n, amountOut: 5_000_000n, feeLamports: 5_000, rentLamports: RENT });
    const fill = await executeBuyFill(MINT, 5, pair, "solana");
    expect(fill.gasCostUsd).toBeCloseTo(((5_000 + RENT) / 1e9) * 100, 9);
    expect(fill.receipt).toEqual({ feeLamports: 5_000, rentLamports: RENT });
  });
});

describe("token-account rent in realized P&L", () => {
  // $5 in, $5.50 out; fees 5,000 lamports a transaction at $100/SOL.
  const usd = (lamports: number) => (lamports / 1e9) * 100;

  it("cancels out when the account is closed, leaving only the fees", () => {
    const buyGas = usd(5_000 + RENT);
    const sellGas = usd(5_000 + 5_000 - RENT);
    const { realizedPnlUsd } = tradeRealizedPnl({ totalBuyUsd: 5, totalSellUsd: 5.5, totalGasUsd: buyGas + sellGas });
    expect(realizedPnlUsd).toBeCloseTo(0.5 - usd(15_000), 9);
  });

  it("stays a cost of the trade when the account couldn't be closed", () => {
    const { realizedPnlUsd } = tradeRealizedPnl({ totalBuyUsd: 5, totalSellUsd: 5.5, totalGasUsd: usd(5_000 + RENT) + usd(5_000) });
    expect(realizedPnlUsd).toBeCloseTo(0.5 - usd(10_000 + RENT), 9);
  });
});

describe("gasLedgerNote", () => {
  it("keeps the old notes when there's no rent involved", () => {
    expect(gasLedgerNote({ provider: "paper" })).toBe("simulated gas");
    expect(gasLedgerNote({ provider: "live" })).toBe("real gas");
    expect(gasLedgerNote({ provider: "live", receipt: { feeLamports: 5_000 } })).toBe("real gas");
  });

  it("names rent paid on a buy", () => {
    expect(gasLedgerNote({ provider: "live", receipt: { feeLamports: 5_000, rentLamports: RENT } })).toContain("incl. 1513840 lamports token-account rent");
  });
});
