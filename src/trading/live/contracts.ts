// Verified against live Robinhood Chain bytecode (eth_getCode, all non-empty)
// before ever being used in this codebase — see conversation history / README.
// Source: https://developers.uniswap.org/docs/protocols/v4/deployments
export const UNISWAP_V4_ADDRESSES = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  // Canonical Permit2 address — identical on every chain (deployed via CREATE2
  // by Uniswap), which is itself strong corroboration this is correct.
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
} as const;

export const NATIVE_ETH_CURRENCY = "0x0000000000000000000000000000000000000000" as const;

// Uniswap v2/v3 on Robinhood Chain (chainId 4663) — from Uniswap's own
// deployment registry (github.com/Uniswap/contracts deployments/4663.md) and
// docs (developers.uniswap.org v3-robinhood-chain-deployments), 2026-09-24.
// Confirmed live the same day: this chain's v3 pools match the canonical
// init-code hash, and BOTH Universal Routers deployed here revert on every
// v2/v3 swap command (v4-only deployments), while SwapRouter02 executes v2
// and v3 swaps — including full buy -> sell -> unwrap round-trips — from the
// bot's wallet. So v2/v3 trades go through SwapRouter02; v4 stays on the
// Universal Router.
export const UNISWAP_LEGACY_ADDRESSES = {
  v2Factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
  // Read-only here: getAmountsOut for v2 quotes. Never approved or sent to.
  v2Router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  swapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
} as const;

export const V2_FACTORY_ABI = [
  {
    type: "function",
    name: "getPair",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }],
    outputs: [{ type: "address" }],
  },
] as const;

export const V3_FACTORY_ABI = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

export const V3_STANDARD_FEE_TIERS = [100, 500, 3000, 10_000] as const;

export const LEGACY_POOL_ABI = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;

export const QUOTER_V2_ABI = [
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      { name: "path", type: "bytes" },
      { name: "amountIn", type: "uint256" },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96AfterList", type: "uint160[]" },
      { name: "initializedTicksCrossedList", type: "uint32[]" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

export const V2_ROUTER_QUOTE_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

// SwapRouter02 (router-contracts): recipient address(1) = msg.sender,
// address(2) = the router itself; amountIn 0 = the router's whole balance.
export const SWAP_ROUTER_02_ABI = [
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [
      { name: "deadline", type: "uint256" },
      { name: "data", type: "bytes[]" },
    ],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "payable",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "to", type: "address" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    type: "function",
    name: "unwrapWETH9",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
] as const;

// Router allowlist (§28) — only these addresses are ever signed a transaction
// to. Configurable via ALLOWED_ROUTER_ADDRESSES, but defaults to exactly the
// verified Universal Router above; nothing in this codebase approves an
// unknown spender.
export function getAllowedRouterAddresses(): string[] {
  const fromEnv = process.env.ALLOWED_ROUTER_ADDRESSES;
  if (fromEnv) return fromEnv.split(",").map((a) => a.trim().toLowerCase());
  return [UNISWAP_V4_ADDRESSES.universalRouter, UNISWAP_LEGACY_ADDRESSES.swapRouter02];
}

export function isRouterAllowed(address: string): boolean {
  return getAllowedRouterAddresses().includes(address.toLowerCase());
}

// Ground-truth constants confirmed against live Uniswap v4-core/v4-periphery
// source (Actions.sol, Commands.sol) — NOT reconstructed from memory or an
// AI-summarized doc page, given what's at stake if these are wrong.
export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  // Multi-hop exact-input. Struct layout (ExactInputParams/PathKey in
  // swapEncoding.ts) verified 2026-09-24 against v4-periphery main AND by a
  // successful eth_call of real ETH->META->MUSETOWN calldata against this
  // chain's deployed Universal Router.
  SWAP_EXACT_IN: 0x07,
  // (currency, amount, payerIsUser) — payerIsUser=false pays from the
  // router's own balance, e.g. WETH it just wrapped.
  SETTLE: 0x0b,
  SETTLE_ALL: 0x0c,
  // (currency, recipient, amount) — amount 0 (OPEN_DELTA) takes the full credit.
  TAKE: 0x0e,
  TAKE_ALL: 0x0f,
} as const;

// v4-periphery ActionConstants / Universal Router Constants recipients.
export const ROUTER_RECIPIENT = {
  MSG_SENDER: "0x0000000000000000000000000000000000000001",
  ADDRESS_THIS: "0x0000000000000000000000000000000000000002",
} as const;

// Robinhood Chain's WETH — the quote token of every WETH-paired pool
// DexScreener lists, and (confirmed by a successful WRAP_ETH dry-run through
// the deployed router, 2026-09-24) the WETH9 the Universal Router wraps into.
// There is no native-ETH/WETH v4 pool, so WETH-paired pools are reached by
// having the router wrap/unwrap around the v4 swap.
export const ROBINHOOD_WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;

// Robinhood Chain's main stablecoin — the deepest non-ETH pairing currency
// (8% of tokens' main pools, 2026-09-24), checked directly on-chain as a hub
// so a USDG-paired v2/v3 position stays sellable even if DexScreener stops
// listing its pool.
export const ROBINHOOD_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

// Pools whose key carries this flag charge a fee the hook sets per swap, so
// the key's fee field is a flag, not a fee — never compare it against
// MAX_REASONABLE_POOL_FEE (v4-core LPFeeLibrary.DYNAMIC_FEE_FLAG). The live
// quote already reflects whatever the hook actually charges.
export const DYNAMIC_FEE_FLAG = 0x800000;

const QUOTER_POOL_KEY = {
  name: "poolKey",
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

const QUOTER_PATH = {
  name: "path",
  type: "tuple[]",
  components: [
    { name: "intermediateCurrency", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
    { name: "hookData", type: "bytes" },
  ],
} as const;

// V4Quoter (IV4Quoter.sol) — eth_call-simulated quotes, never a state change.
export const V4_QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [QUOTER_POOL_KEY, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "quoteExactInput",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [{ name: "exactCurrency", type: "address" }, QUOTER_PATH, { name: "exactAmount", type: "uint128" }],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

// PositionManager.poolKeys(bytes25 truncatedPoolId) — returns the full
// PoolKey for any pool that has had a position minted through the
// PositionManager (i.e. essentially every pool with real liquidity) in a
// single eth_call, instead of scanning up to ~12M blocks of Initialize
// events. Callers must re-hash the returned key and compare it to the poolId
// (a pool with no PositionManager positions returns an all-zero key).
export const POSITION_MANAGER_POOL_KEYS_ABI = [
  {
    type: "function",
    name: "poolKeys",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes25" }],
    outputs: [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickSpacing", type: "int24" },
      { name: "hooks", type: "address" },
    ],
  },
] as const;

export const UNIVERSAL_ROUTER_COMMANDS = {
  // (recipient, amountMin) — wraps the router's ETH balance (msg.value).
  WRAP_ETH: 0x0b,
  // (recipient, amountMin) — unwraps the router's WETH and sends ETH on.
  UNWRAP_WETH: 0x0c,
  V4_SWAP: 0x10,
} as const;

export const POOL_MANAGER_ABI = [
  {
    type: "event",
    name: "Initialize",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "currency0", type: "address", indexed: true },
      { name: "currency1", type: "address", indexed: true },
      { name: "fee", type: "uint24", indexed: false },
      { name: "tickSpacing", type: "int24", indexed: false },
      { name: "hooks", type: "address", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "tick", type: "int24", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Swap",
    inputs: [
      { name: "id", type: "bytes32", indexed: true },
      { name: "sender", type: "address", indexed: true },
      { name: "amount0", type: "int128", indexed: false },
      { name: "amount1", type: "int128", indexed: false },
      { name: "sqrtPriceX96", type: "uint160", indexed: false },
      { name: "liquidity", type: "uint128", indexed: false },
      { name: "tick", type: "int24", indexed: false },
      { name: "fee", type: "uint24", indexed: false },
    ],
  },
] as const;

export const STATE_VIEW_ABI = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getLiquidity",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

// V4 fee is in hundredths of a bip (1e-6) — 1,000,000 == 100%. A pool this
// codebase found permissionlessly via raw Initialize events, not through any
// curated/restricted factory, so nothing stops someone from deploying one
// with an extreme LP fee. Confirmed live: a token's only pool had fee=900000
// (90%) with zero hooks — a real, initialized, non-trivial-liquidity pool
// that would still eat ~90%+ of any trade's value before the swap curve ever
// sees it. getBuyEstimate's price-impact check catches this too (it shows up
// as an absurd, correct price-impact number), but a token can also fail here
// BEFORE ever reaching that estimate (e.g. getLiveQuote called directly by
// executeLiveBuy/Sell) — this is the earlier, clearly-labeled version of the
// same protection, so a rejection reads as "pool fee too high" instead of a
// cryptic four-digit percentage.
export const MAX_REASONABLE_POOL_FEE = 50_000; // 5%

export const ERC20_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

// Permit2's IAllowanceTransfer — on-chain (non-signature) approve/allowance,
// simpler and appropriate for a bot that repeatedly trades the same token
// rather than the EIP-712 signed-permit flow meant for one-off approvals.
export const PERMIT2_ALLOWANCE_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
    ],
    outputs: [],
  },
] as const;

export const UNIVERSAL_ROUTER_EXECUTE_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "payable",
    inputs: [
      { name: "commands", type: "bytes" },
      { name: "inputs", type: "bytes[]" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [],
  },
] as const;
