import { describe, expect, it } from "vitest";
import { scoreNarrativeCandidate } from "./narratives";
import type { MarketPair, TrendingMeta } from "../dex/types";

const meta: TrendingMeta = {
  name: "Cat",
  slug: "cat",
  marketCap: 750_000_000,
  liquidity: 50_000_000,
  volume: 220_000_000,
  tokenCount: 94,
  marketCapChange: { m5: 1, h1: 8, h6: 22, h24: 40 },
};

function pair(overrides: Partial<MarketPair> = {}): MarketPair {
  return {
    chainId: "robinhood",
    dexId: "uniswap",
    pairAddress: "0xpair",
    url: "https://dexscreener.com/robinhood/0xpair",
    baseTokenAddress: "0xtoken",
    baseTokenName: "Cat Runner",
    baseTokenSymbol: "CAT",
    liquidityUsd: 35_000,
    volume1h: 70_000,
    volume24h: 500_000,
    buys1h: 70,
    sells1h: 30,
    priceChange1h: 24,
    websites: [],
    socials: [],
    ...overrides,
  };
}

describe("scoreNarrativeCandidate", () => {
  it("passes when a strong meta is confirmed by this token's real demand", () => {
    const score = scoreNarrativeCandidate({
      meta,
      metaRank: 1,
      pair: pair(),
      xFindings: {
        query: "(Cat OR $CAT)",
        tweetCount: 50,
        uniqueAccountCount: 20,
        totalEngagement: 500,
        credibleAccountCount: 5,
        sampleTweetUrls: [],
        accounts: [],
      },
    });

    expect(score.passed).toBe(true);
    expect(score.score).toBeGreaterThanOrEqual(68);
  });

  it("rejects a good narrative when the specific token has no volume confirmation", () => {
    const score = scoreNarrativeCandidate({
      meta,
      metaRank: 1,
      pair: pair({ buys1h: 2, sells1h: 1, volume1h: 300 }),
    });

    expect(score.passed).toBe(false);
    expect(score.reasons.join(" ")).toContain("token hourly txns");
  });

  it("rejects churn even when headline volume is high", () => {
    const score = scoreNarrativeCandidate({
      meta,
      metaRank: 1,
      pair: pair({ liquidityUsd: 10_000, volume1h: 250_000, buys1h: 150, sells1h: 120 }),
    });

    expect(score.passed).toBe(false);
    expect(score.reasons.join(" ")).toContain("volume/liquidity");
  });
});
