import { encodeAbiParameters, encodePacked } from "viem";
import { V4_ACTIONS, ROUTER_RECIPIENT } from "./contracts";
import type { PoolKey } from "./poolDiscovery";

const EXACT_INPUT_SINGLE_PARAMS_TYPE = {
  type: "tuple",
  components: [
    {
      name: "poolKey",
      type: "tuple",
      components: [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" },
      ],
    },
    { name: "zeroForOne", type: "bool" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
    { name: "minHopPriceX36", type: "uint256" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

export interface PathKey {
  intermediateCurrency: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  hookData: `0x${string}`;
}

export const PATH_KEY_ARRAY_TYPE = {
  type: "tuple[]",
  components: [
    { name: "intermediateCurrency", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

const EXACT_INPUT_PARAMS_TYPE = {
  type: "tuple",
  components: [
    { name: "currencyIn", type: "address" },
    { name: "path", ...PATH_KEY_ARRAY_TYPE },
    { name: "minHopPriceX36", type: "uint256[]" },
    { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" },
  ],
} as const;

export type V4SwapSpec =
  | { kind: "single"; poolKey: PoolKey; zeroForOne: boolean }
  | { kind: "multi"; path: PathKey[] };

/**
 * General V4_SWAP payload. settleFrom "user" pays with the caller's funds
 * (SETTLE_ALL: msg.value for ETH, Permit2 for tokens); "router" pays from the
 * router's own balance (SETTLE, payerIsUser=false) — e.g. WETH it just
 * wrapped. takeTo "user" sends the output to the caller with the slippage
 * floor (TAKE_ALL); "router" leaves it with the router (TAKE to ADDRESS_THIS,
 * full credit) for a following UNWRAP_WETH to pay out and floor instead.
 */
export function encodeV4Swap(input: {
  swap: V4SwapSpec;
  currencyIn: `0x${string}`;
  currencyOut: `0x${string}`;
  amountIn: bigint;
  amountOutMinimum: bigint;
  settleFrom: "user" | "router";
  takeTo: "user" | "router";
}): `0x${string}` {
  const swapAction = input.swap.kind === "single" ? V4_ACTIONS.SWAP_EXACT_IN_SINGLE : V4_ACTIONS.SWAP_EXACT_IN;
  const settleAction = input.settleFrom === "user" ? V4_ACTIONS.SETTLE_ALL : V4_ACTIONS.SETTLE;
  const takeAction = input.takeTo === "user" ? V4_ACTIONS.TAKE_ALL : V4_ACTIONS.TAKE;
  const actions = encodePacked(["uint8", "uint8", "uint8"], [swapAction, settleAction, takeAction]);

  const swapParams =
    input.swap.kind === "single"
      ? encodeAbiParameters(
          [EXACT_INPUT_SINGLE_PARAMS_TYPE],
          [
            {
              poolKey: input.swap.poolKey,
              zeroForOne: input.swap.zeroForOne,
              amountIn: input.amountIn,
              amountOutMinimum: input.amountOutMinimum,
              minHopPriceX36: 0n,
              hookData: "0x",
            },
          ]
        )
      : encodeAbiParameters(
          [EXACT_INPUT_PARAMS_TYPE],
          [{ currencyIn: input.currencyIn, path: input.swap.path, minHopPriceX36: [], amountIn: input.amountIn, amountOutMinimum: input.amountOutMinimum }]
        );
  const settleParams =
    input.settleFrom === "user"
      ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [input.currencyIn, input.amountIn])
      : encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bool" }], [input.currencyIn, input.amountIn, false]);
  const takeParams =
    input.takeTo === "user"
      ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [input.currencyOut, input.amountOutMinimum])
      : encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint256" }], [input.currencyOut, ROUTER_RECIPIENT.ADDRESS_THIS, 0n]);

  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settleParams, takeParams]]);
}

/**
 * Multi-hop exact-input V4 swap (e.g. ETH -> META -> token), same
 * SETTLE_ALL/TAKE_ALL settlement as the single-hop version below. An empty
 * minHopPriceX36 disables per-hop price checks; amountOutMinimum on the final
 * output is the slippage bound, exactly as for a single hop.
 */
export function encodeV4SwapExactIn(input: {
  currencyIn: `0x${string}`;
  path: PathKey[];
  amountIn: bigint;
  amountOutMinimum: bigint;
  currencyOut: `0x${string}`;
}): `0x${string}` {
  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [V4_ACTIONS.SWAP_EXACT_IN, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]
  );
  const swapParams = encodeAbiParameters(
    [EXACT_INPUT_PARAMS_TYPE],
    [
      {
        currencyIn: input.currencyIn,
        path: input.path,
        minHopPriceX36: [],
        amountIn: input.amountIn,
        amountOutMinimum: input.amountOutMinimum,
      },
    ]
  );
  const settleParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [input.currencyIn, input.amountIn]);
  const takeParams = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [input.currencyOut, input.amountOutMinimum]);
  return encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, [swapParams, settleParams, takeParams]]);
}

/**
 * Encodes a single-hop exact-input V4 swap as the `inputs[0]` payload for the
 * Universal Router's V4_SWAP command (0x10). Verified field-for-field against
 * live Uniswap v4-periphery source (Actions.sol, IV4Router.sol, V4Router.sol)
 * — see poolDiscovery.ts/contracts.ts comments for what was checked.
 *
 * `zeroForOne=true` means currency0 -> currency1 (buying the token with ETH,
 * since ETH is always currency0 in an ETH pool). `zeroForOne=false` is the
 * sell direction.
 */
export function encodeV4SwapExactInSingle(input: {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  settleCurrency: `0x${string}`; // what's being paid in (ETH for a buy, the token for a sell)
  takeCurrency: `0x${string}`; // what's being received (the token for a buy, ETH for a sell)
}): `0x${string}` {
  const actions = encodePacked(
    ["uint8", "uint8", "uint8"],
    [V4_ACTIONS.SWAP_EXACT_IN_SINGLE, V4_ACTIONS.SETTLE_ALL, V4_ACTIONS.TAKE_ALL]
  );

  const swapParams = encodeAbiParameters(
    [EXACT_INPUT_SINGLE_PARAMS_TYPE],
    [
      {
        poolKey: input.poolKey,
        zeroForOne: input.zeroForOne,
        amountIn: input.amountIn,
        amountOutMinimum: input.amountOutMinimum,
        minHopPriceX36: 0n,
        hookData: "0x",
      },
    ]
  );
  const settleParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [input.settleCurrency, input.amountIn]
  );
  const takeParams = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [input.takeCurrency, input.amountOutMinimum]
  );

  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParams, settleParams, takeParams]]
  );
}
