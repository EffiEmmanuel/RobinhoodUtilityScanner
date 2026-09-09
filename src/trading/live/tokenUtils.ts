import type { PublicClient } from "viem";

const ERC20_READ_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export async function getTokenDecimals(client: PublicClient, tokenAddress: `0x${string}`): Promise<number> {
  const decimals = await client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "decimals" });
  return decimals;
}

export async function getTokenBalance(client: PublicClient, tokenAddress: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return client.readContract({ address: tokenAddress, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [owner] });
}
