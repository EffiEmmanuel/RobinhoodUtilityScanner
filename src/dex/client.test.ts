import { describe, it, expect } from "vitest";
import { selectMarketPairs } from "./client";
import type { MarketPair } from "./types";

const NATIVE_ETH = "0x0000000000000000000000000000000000000000";
const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35";

function pair(overrides: Partial<MarketPair>): MarketPair {
  return { dexId: "uniswap", pairAddress: "0xpool", url: "", websites: [], socials: [], ...overrides } as MarketPair;
}

describe("selectMarketPairs", () => {
  // MUSETOWN's real shape on 2026-09-24.
  const metaPool = pair({ pairAddress: "0xmeta", quoteTokenAddress: META, quoteSymbol: "META", liquidityUsd: 48_722, priceUsd: 0.000314, priceNative: 0.00000042 });
  const ethPool = pair({ pairAddress: "0xeth", quoteTokenAddress: NATIVE_ETH, quoteSymbol: "ETH", liquidityUsd: 550, priceUsd: 0.00032, priceNative: 0.00000012 });

  it("uses the token's deepest pool as its market, whatever it's paired against", () => {
    expect(selectMarketPairs("robinhood", [ethPool, metaPool]).primaryPair).toBe(metaPool);
  });

  it("still exposes the ETH pool separately, the only safe source of an ETH rate", () => {
    expect(selectMarketPairs("robinhood", [ethPool, metaPool]).ethPair).toBe(ethPool);
    expect(selectMarketPairs("robinhood", [metaPool]).ethPair).toBeUndefined();
  });

  it("prefers a pool the bot can trade (Uniswap) over a deeper one on another DEX", () => {
    const sushi = pair({ dexId: "sushiswap", pairAddress: "0xsushi", liquidityUsd: 500_000 });
    expect(selectMarketPairs("robinhood", [sushi, metaPool]).primaryPair).toBe(metaPool);
  });

  it("keeps Solana on plain deepest-liquidity ordering", () => {
    const pumpswap = pair({ dexId: "pumpswap", pairAddress: "0xpumpswap", liquidityUsd: 15_000 });
    const meteora = pair({ dexId: "meteora", pairAddress: "0xmeteora", liquidityUsd: 120 });
    expect(selectMarketPairs("solana", [meteora, pumpswap]).primaryPair).toBe(pumpswap);
  });
});
