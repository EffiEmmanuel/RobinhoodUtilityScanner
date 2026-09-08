import { createPublicClient, http, toFunctionSelector, isAddressEqual, zeroAddress } from "viem";
import { config } from "../config";
import { logger } from "../logger";
import type { ResearchStatus } from "./website";

// PASS = safe (risk not found) / FAIL = risk found / UNKNOWN = could not determine.
// Never conflate UNKNOWN with PASS — see PRD FR-014 / §25.
export type CheckResult = "PASS" | "FAIL" | "UNKNOWN" | "NOT_APPLICABLE";

export interface OnchainResearchResult {
  status: ResearchStatus;
  isContract: CheckResult;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  ownerAddress?: string;
  ownerRenounced: CheckResult;
  mintCapability: CheckResult;
  pauseCapability: CheckResult;
  blacklistCapability: CheckResult;
  feeControlCapability: CheckResult;
  verifiedSource: CheckResult;
  flags: string[];
}

const ERC20_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

// Signatures whose selectors we look for in the deployed bytecode's dispatch
// table. A lightweight static-analysis heuristic (no source needed) — if the
// contract is verified on the explorer we prefer that instead (see below).
const RISK_SIGNATURES = {
  mint: ["mint(address,uint256)", "mint(uint256)"],
  pause: ["pause()", "setPaused(bool)"],
  blacklist: ["blacklist(address)", "setBlacklist(address,bool)", "addBlacklist(address)", "blacklistAddress(address,bool)"],
  feeControl: ["setTaxFee(uint256)", "setFees(uint256,uint256)", "excludeFromFee(address)", "setFeePercent(uint256)"],
} as const;

function bytecodeContainsSelector(bytecode: string, signature: string): boolean {
  const selector = toFunctionSelector(signature).slice(2).toLowerCase();
  return bytecode.toLowerCase().includes(selector);
}

function anySelectorPresent(bytecode: string, signatures: readonly string[]): boolean {
  return signatures.some((sig) => {
    try {
      return bytecodeContainsSelector(bytecode, sig);
    } catch {
      return false;
    }
  });
}

async function checkVerifiedSource(address: string): Promise<{ verified: CheckResult; abiFlags: string[] }> {
  if (!config.rhExplorerApiUrl) return { verified: "UNKNOWN", abiFlags: [] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${config.rhExplorerApiUrl}/smart-contracts/${address}`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { verified: res.status === 404 ? "FAIL" : "UNKNOWN", abiFlags: [] };
    const data = (await res.json()) as { is_verified?: boolean; proxy_type?: string | null };
    const flags: string[] = [];
    if (data.proxy_type) flags.push(`upgradeable proxy detected (${data.proxy_type})`);
    return { verified: data.is_verified ? "PASS" : "FAIL", abiFlags: flags };
  } catch (err) {
    logger.warn({ address, err: String(err) }, "explorer verified-source lookup failed");
    return { verified: "UNKNOWN", abiFlags: [] };
  }
}

export async function researchOnchain(tokenAddress: string): Promise<OnchainResearchResult> {
  const flags: string[] = [];
  const client = createPublicClient({ transport: http(config.rhRpcUrl) });
  const address = tokenAddress as `0x${string}`;

  let bytecode: string | undefined;
  try {
    bytecode = await client.getCode({ address });
  } catch (err) {
    logger.warn({ tokenAddress, err: String(err) }, "onchain research: RPC unreachable");
    return {
      status: "UNAVAILABLE",
      isContract: "UNKNOWN",
      ownerRenounced: "UNKNOWN",
      mintCapability: "UNKNOWN",
      pauseCapability: "UNKNOWN",
      blacklistCapability: "UNKNOWN",
      feeControlCapability: "UNKNOWN",
      verifiedSource: "UNKNOWN",
      flags: [`RPC unreachable: ${String(err)}`],
    };
  }

  if (!bytecode || bytecode === "0x") {
    return {
      status: "PARTIAL",
      isContract: "FAIL",
      ownerRenounced: "NOT_APPLICABLE",
      mintCapability: "NOT_APPLICABLE",
      pauseCapability: "NOT_APPLICABLE",
      blacklistCapability: "NOT_APPLICABLE",
      feeControlCapability: "NOT_APPLICABLE",
      verifiedSource: "NOT_APPLICABLE",
      flags: ["no bytecode at this address"],
    };
  }

  const [name, symbol, decimals, totalSupply, owner] = await Promise.allSettled([
    client.readContract({ address, abi: ERC20_ABI, functionName: "name" }),
    client.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }),
    client.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }),
    client.readContract({ address, abi: ERC20_ABI, functionName: "totalSupply" }),
    client.readContract({ address, abi: ERC20_ABI, functionName: "owner" }),
  ]);

  const ownerAddress = owner.status === "fulfilled" ? (owner.value as string) : undefined;
  let ownerRenounced: CheckResult = "UNKNOWN";
  if (ownerAddress) {
    ownerRenounced = isAddressEqual(ownerAddress as `0x${string}`, zeroAddress) ? "PASS" : "FAIL";
  } else if (owner.status === "rejected") {
    // no owner() function at all — there's no classic-Ownable admin key to renounce
    ownerRenounced = "NOT_APPLICABLE";
  }

  const { verified, abiFlags } = await checkVerifiedSource(tokenAddress);
  flags.push(...abiFlags);

  const mintCapability: CheckResult = anySelectorPresent(bytecode, RISK_SIGNATURES.mint) ? "FAIL" : "PASS";
  const pauseCapability: CheckResult = anySelectorPresent(bytecode, RISK_SIGNATURES.pause) ? "FAIL" : "PASS";
  const blacklistCapability: CheckResult = anySelectorPresent(bytecode, RISK_SIGNATURES.blacklist) ? "FAIL" : "PASS";
  const feeControlCapability: CheckResult = anySelectorPresent(bytecode, RISK_SIGNATURES.feeControl) ? "FAIL" : "PASS";

  if (mintCapability === "FAIL") flags.push("mint-like function selector present in bytecode");
  if (pauseCapability === "FAIL") flags.push("pause-like function selector present in bytecode");
  if (blacklistCapability === "FAIL") flags.push("blacklist-like function selector present in bytecode");
  if (feeControlCapability === "FAIL") flags.push("fee/tax-control function selector present in bytecode");

  return {
    status: "SUCCESS",
    isContract: "PASS",
    name: name.status === "fulfilled" ? (name.value as string) : undefined,
    symbol: symbol.status === "fulfilled" ? (symbol.value as string) : undefined,
    decimals: decimals.status === "fulfilled" ? Number(decimals.value) : undefined,
    totalSupply: totalSupply.status === "fulfilled" ? (totalSupply.value as bigint).toString() : undefined,
    ownerAddress,
    ownerRenounced,
    mintCapability,
    pauseCapability,
    blacklistCapability,
    feeControlCapability,
    verifiedSource: verified,
    flags,
  };
}

export function formatOnchainResultForPrompt(r: OnchainResearchResult): string {
  if (r.status === "UNAVAILABLE") return "On-chain RPC was unreachable; no contract data available.";
  const lines = [
    `Is contract: ${r.isContract}`,
    r.name ? `Name (on-chain): ${r.name}` : undefined,
    r.symbol ? `Symbol (on-chain): ${r.symbol}` : undefined,
    r.decimals !== undefined ? `Decimals: ${r.decimals}` : undefined,
    r.totalSupply ? `Total supply (raw): ${r.totalSupply}` : undefined,
    r.ownerAddress ? `Owner address: ${r.ownerAddress}` : "Owner: no owner() function found",
    `Owner renounced: ${r.ownerRenounced}`,
    `Mint capability present: ${r.mintCapability === "FAIL" ? "YES (risk)" : r.mintCapability}`,
    `Pause capability present: ${r.pauseCapability === "FAIL" ? "YES (risk)" : r.pauseCapability}`,
    `Blacklist capability present: ${r.blacklistCapability === "FAIL" ? "YES (risk)" : r.blacklistCapability}`,
    `Fee/tax control present: ${r.feeControlCapability === "FAIL" ? "YES (risk)" : r.feeControlCapability}`,
    `Source verified on explorer: ${r.verifiedSource}`,
    r.flags.length ? `Flags: ${r.flags.join("; ")}` : undefined,
  ].filter(Boolean);
  return lines.join("\n");
}
