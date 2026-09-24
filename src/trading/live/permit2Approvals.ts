import { encodeFunctionData, maxUint160 } from "viem";
import { logger } from "../../logger";
import { UNISWAP_V4_ADDRESSES, UNISWAP_LEGACY_ADDRESSES, ERC20_ALLOWANCE_ABI, PERMIT2_ALLOWANCE_ABI } from "./contracts";
import { getPublicClient, getWalletAddress, signAndSendTransaction } from "./wallet";

// Short-lived on purpose (§28: "prefer exact/limited token approvals... do
// not automatically grant unlimited approvals unless explicitly configured
// and audited"). Re-approving each time a stale/insufficient allowance is
// found costs one extra transaction but keeps the standing approval small
// and time-boxed rather than an indefinite max-uint grant.
const PERMIT2_APPROVAL_TTL_SECONDS = 3600;

/**
 * Selling through SwapRouter02 (v2/v3 pools — see contracts.ts's
 * UNISWAP_LEGACY_ADDRESSES) pulls the token with a plain ERC20 transferFrom,
 * so it needs a direct approval of exactly the amount being sold — topped up
 * only when the existing allowance is short, same as the Permit2 path.
 */
export async function ensureSwapRouter02Approval(tokenAddress: `0x${string}`, amountNeeded: bigint): Promise<string[]> {
  const client = getPublicClient();
  const owner = getWalletAddress();
  const spender = UNISWAP_LEGACY_ADDRESSES.swapRouter02 as `0x${string}`;
  const allowance = await client.readContract({ address: tokenAddress, abi: ERC20_ALLOWANCE_ABI, functionName: "allowance", args: [owner, spender] });
  if (allowance >= amountNeeded) return [];
  const data = encodeFunctionData({ abi: ERC20_ALLOWANCE_ABI, functionName: "approve", args: [spender, amountNeeded] });
  const hash = await signAndSendTransaction({ to: tokenAddress, data, value: 0n, purpose: "erc20-approve-swaprouter02" });
  await client.waitForTransactionReceipt({ hash });
  logger.info({ tokenAddress, hash }, "sent ERC20 approve(SwapRouter02) for a v2/v3 sell");
  return [hash];
}

/**
 * Selling a token through the Universal Router pulls funds via Permit2's
 * on-chain allowance mechanism (confirmed against live V4SwapRouter source:
 * `_payStandard` calls `payOrPermit2Transfer`) — this needs two approvals in
 * place: the token's own ERC20 approve(Permit2, ...), and Permit2's own
 * approve(token, UniversalRouter, ...). Both are checked and only topped up
 * if actually insufficient; a token already approved from a prior sell skips
 * both transactions.
 */
export async function ensureSellApprovals(tokenAddress: `0x${string}`, amountNeeded: bigint): Promise<string[]> {
  if (amountNeeded > maxUint160) {
    throw new Error(`sell amount ${amountNeeded} exceeds Permit2's uint160 allowance limit`);
  }
  const client = getPublicClient();
  const owner = getWalletAddress();
  const sentTxHashes: string[] = [];

  const erc20Allowance = await client.readContract({
    address: tokenAddress,
    abi: ERC20_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [owner, UNISWAP_V4_ADDRESSES.permit2 as `0x${string}`],
  });
  if (erc20Allowance < amountNeeded) {
    const data = encodeFunctionData({
      abi: ERC20_ALLOWANCE_ABI,
      functionName: "approve",
      args: [UNISWAP_V4_ADDRESSES.permit2 as `0x${string}`, amountNeeded],
    });
    const hash = await signAndSendTransaction({ to: tokenAddress, data, value: 0n, purpose: "erc20-approve-permit2" });
    await client.waitForTransactionReceipt({ hash });
    sentTxHashes.push(hash);
    logger.info({ tokenAddress, hash }, "sent ERC20 approve(Permit2) for sell");
  }

  const [permit2Amount, expiration] = await client.readContract({
    address: UNISWAP_V4_ADDRESSES.permit2 as `0x${string}`,
    abi: PERMIT2_ALLOWANCE_ABI,
    functionName: "allowance",
    args: [owner, tokenAddress, UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`],
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (permit2Amount < amountNeeded || expiration < nowSeconds) {
    const newExpiration = nowSeconds + PERMIT2_APPROVAL_TTL_SECONDS;
    const data = encodeFunctionData({
      abi: PERMIT2_ALLOWANCE_ABI,
      functionName: "approve",
      args: [tokenAddress, UNISWAP_V4_ADDRESSES.universalRouter as `0x${string}`, amountNeeded, newExpiration],
    });
    const hash = await signAndSendTransaction({ to: UNISWAP_V4_ADDRESSES.permit2 as `0x${string}`, data, value: 0n, purpose: "permit2-approve-router" });
    await client.waitForTransactionReceipt({ hash });
    sentTxHashes.push(hash);
    logger.info({ tokenAddress, hash }, "sent Permit2 approve(UniversalRouter) for sell");
  }

  return sentTxHashes;
}
