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

// Router allowlist (§28) — only these addresses are ever signed a transaction
// to. Configurable via ALLOWED_ROUTER_ADDRESSES, but defaults to exactly the
// verified Universal Router above; nothing in this codebase approves an
// unknown spender.
export function getAllowedRouterAddresses(): string[] {
  const fromEnv = process.env.ALLOWED_ROUTER_ADDRESSES;
  if (fromEnv) return fromEnv.split(",").map((a) => a.trim().toLowerCase());
  return [UNISWAP_V4_ADDRESSES.universalRouter];
}

// Ground-truth constants confirmed against live Uniswap v4-core/v4-periphery
// source (Actions.sol, Commands.sol) — NOT reconstructed from memory or an
// AI-summarized doc page, given what's at stake if these are wrong.
export const V4_ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE_ALL: 0x0c,
  TAKE_ALL: 0x0f,
} as const;

export const UNIVERSAL_ROUTER_COMMANDS = {
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
