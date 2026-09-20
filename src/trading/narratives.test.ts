import { describe, expect, it } from "vitest";
import { scoreNarrativeCandidate, evaluateNarrativeQuality } from "./narratives";
import { tradingConfig } from "./config";
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
    marketCapUsd: 800_000,
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
        sampleTweetTexts: [],
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

  it("rejects a token with thin 24h turnover relative to its market cap (bundling red flag)", () => {
    const score = scoreNarrativeCandidate({
      meta,
      metaRank: 1,
      pair: pair({ marketCapUsd: 10_000_000, volume24h: 200_000 }), // 2% turnover
    });

    expect(score.passed).toBe(false);
    expect(score.reasons.join(" ")).toContain("volume/mcap ratio");
  });

  it("rejects when market cap data is missing entirely", () => {
    const score = scoreNarrativeCandidate({
      meta,
      metaRank: 1,
      pair: pair({ marketCapUsd: undefined }),
    });

    expect(score.passed).toBe(false);
    expect(score.reasons.join(" ")).toContain("no market cap data");
  });
});

describe("evaluateNarrativeQuality", () => {
  it("passes trivially when the gate is disabled (kill switch)", async () => {
    const original = tradingConfig.narrativeRequireAiNarrativeQuality;
    tradingConfig.narrativeRequireAiNarrativeQuality = false;
    try {
      const result = await evaluateNarrativeQuality(meta, undefined);
      expect(result.passed).toBe(true);
    } finally {
      tradingConfig.narrativeRequireAiNarrativeQuality = original;
    }
  });

  it("hard-rejects with no X data at all — never a silent pass-through", async () => {
    const result = await evaluateNarrativeQuality(meta, undefined);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toContain("cannot verify");
  });

  it("hard-rejects when the X search itself errored", async () => {
    const result = await evaluateNarrativeQuality(meta, {
      query: "(Cat OR $CAT)",
      tweetCount: 0,
      uniqueAccountCount: 0,
      totalEngagement: 0,
      credibleAccountCount: 0,
      sampleTweetUrls: [],
      sampleTweetTexts: [],
      accounts: [],
      error: "HTTP 429",
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toContain("X search failed");
  });

  it("hard-rejects when tweets exist but no readable text was captured", async () => {
    const result = await evaluateNarrativeQuality(meta, {
      query: "(Cat OR $CAT)",
      tweetCount: 5,
      uniqueAccountCount: 3,
      totalEngagement: 20,
      credibleAccountCount: 1,
      sampleTweetUrls: ["https://x.com/i/web/status/1"],
      sampleTweetTexts: [],
      accounts: [],
    });

    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toContain("no tweet content found");
  });
});
