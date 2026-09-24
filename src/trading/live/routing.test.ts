import { describe, it, expect } from "vitest";
import { decodeAbiParameters } from "viem";
import { computePoolId, currencySequence, isPredatoryFee, pathFor, zeroForOneFor, type SwapRoute } from "./routing";
import { encodeV4SwapExactIn, PATH_KEY_ARRAY_TYPE } from "./swapEncoding";
import { NATIVE_ETH_CURRENCY } from "./contracts";

// Real Robinhood Chain pools, keys resolved via PositionManager.poolKeys and
// confirmed to hash to DexScreener's pool ids on 2026-09-24.
const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" as const;
const MUSETOWN = "0x7d6088366196BAb95b862907B710413B10F714A5" as const;
const ETH_META = {
  poolKey: { currency0: NATIVE_ETH_CURRENCY, currency1: META, fee: 2100, tickSpacing: 21, hooks: "0x0000000000000000000000000000000000000000" as const },
  poolId: "0xf89d70906c1464e5f0853fbb0601c111bfb48ef54537c0527694a559b33dd801" as const,
};
const META_MUSETOWN = {
  poolKey: { currency0: MUSETOWN, currency1: META, fee: 0, tickSpacing: 200, hooks: "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044" as const },
  poolId: "0xa2be10b629d96619f86876674c32d92d3e3ca7b4831a978e3add73886e99dd28" as const,
};
const twoHop: SwapRoute = { pools: [ETH_META, META_MUSETOWN], hubs: [META] };

describe("computePoolId", () => {
  it("matches real on-chain pool ids", () => {
    expect(computePoolId(ETH_META.poolKey)).toBe(ETH_META.poolId);
    expect(computePoolId(META_MUSETOWN.poolKey)).toBe(META_MUSETOWN.poolId);
  });
});

describe("pathFor", () => {
  it("builds ETH -> META -> token for a buy", () => {
    const { currencyIn, currencyOut, path } = pathFor(twoHop, MUSETOWN, true);
    expect(currencyIn).toBe(NATIVE_ETH_CURRENCY);
    expect(currencyOut).toBe(MUSETOWN);
    expect(path.map((p) => p.intermediateCurrency)).toEqual([META, MUSETOWN]);
    expect(path[0].fee).toBe(2100);
    expect(path[1].hooks).toBe(META_MUSETOWN.poolKey.hooks);
  });

  it("reverses pools and currencies for a sell", () => {
    const { currencyIn, currencyOut, path } = pathFor(twoHop, MUSETOWN, false);
    expect(currencyIn).toBe(MUSETOWN);
    expect(currencyOut).toBe(NATIVE_ETH_CURRENCY);
    expect(path.map((p) => p.intermediateCurrency)).toEqual([META, NATIVE_ETH_CURRENCY]);
    expect(path[0].tickSpacing).toBe(200);
    expect(path[1].tickSpacing).toBe(21);
  });

  it("sequences currencies in trade order", () => {
    expect(currencySequence(twoHop, MUSETOWN, true)).toEqual([NATIVE_ETH_CURRENCY, META, MUSETOWN]);
    expect(currencySequence(twoHop, MUSETOWN, false)).toEqual([MUSETOWN, META, NATIVE_ETH_CURRENCY]);
  });
});

describe("zeroForOneFor", () => {
  it("follows currency ordering, not trade direction", () => {
    // ETH is always currency0 of a native pool.
    expect(zeroForOneFor(ETH_META.poolKey, NATIVE_ETH_CURRENCY)).toBe(true);
    // MUSETOWN sorts below META, so it is currency0 of that pool.
    expect(zeroForOneFor(META_MUSETOWN.poolKey, META)).toBe(false);
    expect(zeroForOneFor(META_MUSETOWN.poolKey, MUSETOWN)).toBe(true);
  });
});

describe("isPredatoryFee", () => {
  it("flags static fees over 5% but never the dynamic-fee flag", () => {
    expect(isPredatoryFee({ ...ETH_META.poolKey, fee: 810_000 })).toBe(true);
    expect(isPredatoryFee({ ...ETH_META.poolKey, fee: 3000 })).toBe(false);
    expect(isPredatoryFee({ ...ETH_META.poolKey, fee: 0x800000 })).toBe(false);
  });
});

describe("encodeV4SwapExactIn", () => {
  it("round-trips the swap parameters the router will decode", () => {
    const { currencyIn, currencyOut, path } = pathFor(twoHop, MUSETOWN, true);
    const encoded = encodeV4SwapExactIn({ currencyIn, path, amountIn: 1_240_000_000_000_000n, amountOutMinimum: 8_000n, currencyOut });
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], encoded);
    expect(actions).toBe("0x070c0f");
    const [swap] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "currencyIn", type: "address" },
            { name: "path", ...PATH_KEY_ARRAY_TYPE },
            { name: "minHopPriceX36", type: "uint256[]" },
            { name: "amountIn", type: "uint128" },
            { name: "amountOutMinimum", type: "uint128" },
          ],
        },
      ],
      params[0]
    );
    expect(swap.currencyIn).toBe(NATIVE_ETH_CURRENCY);
    expect(swap.path).toHaveLength(2);
    expect(swap.minHopPriceX36).toEqual([]);
    expect(swap.amountIn).toBe(1_240_000_000_000_000n);
    expect(swap.amountOutMinimum).toBe(8_000n);
  });
});
