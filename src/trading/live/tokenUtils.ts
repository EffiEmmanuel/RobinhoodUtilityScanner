import { formatUnits, type PublicClient } from "viem";

const ERC20_READ_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export async function getTokenDecimals(client: PublicClient, tokenAddress: `0x${string}`): Promise<number> {
  const decimals = await client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "decimals" });
  return decimals;
}

export async function getTokenBalance(client: PublicClient, tokenAddress: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [owner] });
}

/** Not every ERC20 implements these (some revert, some return bytes32 instead
 * of string) — callers should treat failures as "unknown", not fatal. */
export async function getTokenNameSymbol(
  client: PublicClient,
  tokenAddress: `0x${string}`
): Promise<{ name?: string; symbol?: string }> {
  const [name, symbol] = await Promise.allSettled([
    client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "name" }),
    client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "symbol" }),
  ]);
  return {
    name: name.status === "fulfilled" ? name.value : undefined,
    symbol: symbol.status === "fulfilled" ? symbol.value : undefined,
  };
}

/** Human-readable circulating-supply count (raw totalSupply adjusted for
 * decimals) — undefined if either call fails rather than fatal, same
 * reasoning as getTokenNameSymbol. */
export async function getAdjustedTotalSupply(client: PublicClient, tokenAddress: `0x${string}`): Promise<number | undefined> {
  const [decimals, supply] = await Promise.allSettled([
    client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "decimals" }),
    client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "totalSupply" }),
  ]);
  if (decimals.status !== "fulfilled" || supply.status !== "fulfilled") return undefined;
  return Number(formatUnits(supply.value, decimals.value));
}
