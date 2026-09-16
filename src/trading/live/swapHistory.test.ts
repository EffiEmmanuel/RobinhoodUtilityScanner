import { describe, expect, it } from "vitest";
import { sqrtPriceX96ToTokenPriceInEth } from "./swapHistory";

describe("sqrtPriceX96ToTokenPriceInEth", () => {
  // Regression test for a silent inversion bug (fixed 2026-09-16): the
  // function returned rawTokensPerEth instead of its reciprocal, so a token
  // priced at a tiny fraction of an ETH came back as an astronomically large
  // number instead — corrupting the on-chain swing-high/low support/
  // resistance feature without ever throwing or failing a test, since no
  // test existed for this function at all.
  it("returns ETH-per-token, not its reciprocal, for equal-decimals tokens", () => {
    // Constructed so that price(token1 per token0) = 10000 raw units, i.e.
    // 1 ETH buys 10000 raw-equivalent tokens at 18/18 decimals -> 0.0001 ETH
    // per token.
    const Q96 = 2n ** 96n;
    const sqrtPriceX96 = 100n * Q96; // sqrt(10000) = 100
    const priceInEth = sqrtPriceX96ToTokenPriceInEth(sqrtPriceX96, 18);
    expect(priceInEth).toBeCloseTo(0.0001, 10);
  });

  it("adjusts for a token with fewer decimals than ETH", () => {
    // tokenDecimals = 9. Chosen so ETH-per-token = 0.00002.
    const targetPriceInEth = 0.00002;
    const raw = 10 ** (9 - 18) / targetPriceInEth; // = rawToken1/rawToken0
    const Q96 = 2 ** 96;
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(raw) * Q96));
    const priceInEth = sqrtPriceX96ToTokenPriceInEth(sqrtPriceX96, 9);
    expect(priceInEth).toBeCloseTo(targetPriceInEth, 8);
  });
});
