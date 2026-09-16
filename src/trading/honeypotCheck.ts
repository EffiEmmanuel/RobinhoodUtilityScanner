import { toFunctionSelector, parseAbi } from "viem";
import { logger } from "../logger";
import { config } from "../config";
import { tradingConfig } from "./config";
import { getPublicClient, getWalletAddress, isWalletConfigured } from "./live/wallet";
import { evaluateSolanaHoneypotRisk } from "./solanaHoneypotCheck";
import { HoneypotCheckInconclusiveError, isHoneypotCheckInconclusiveError, type HoneypotRiskResult } from "./honeypotTypes";

export { HoneypotCheckInconclusiveError, isHoneypotCheckInconclusiveError, type HoneypotRiskResult };

const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const PROBE_RECIPIENT = "0x000000000000000000000000000000000000dEaD" as const;

const HONEYPOT_SIGNATURES = {
  blacklist: [
    "blacklist(address)",
    "setBlacklist(address,bool)",
    "addBlacklist(address)",
    "removeBlacklist(address)",
    "blacklistAddress(address,bool)",
    "setBot(address,bool)",
    "setBots(address[],bool)",
    "isBot(address)",
  ],
  tradingControl: [
    "enableTrading()",
    "openTrading()",
    "setTradingEnabled(bool)",
    "setTradingActive(bool)",
    "setSwapEnabled(bool)",
    "setLimitsInEffect(bool)",
  ],
  transferLimits: [
    "setMaxTxAmount(uint256)",
    "setMaxWalletAmount(uint256)",
    "setMaxTransactionAmount(uint256)",
    "setMaxWallet(uint256)",
    "removeLimits()",
    "setTransferDelayEnabled(bool)",
  ],
  taxControl: [
    "setFees(uint256,uint256)",
    "setTaxFee(uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setFeePercent(uint256)",
    "excludeFromFee(address)",
  ],
} as const;

function isLikelyInfraError(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return (
    message.includes("too many requests") ||
    message.includes("http 429") ||
    message.includes("status: 429") ||
    message.includes("rpc request failed") ||
    message.includes("connection timeout") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("fetch failed") ||
    message.includes("network error")
  );
}

function selectorPresent(bytecode: string, signature: string): boolean {
  try {
    return bytecode.toLowerCase().includes(toFunctionSelector(signature).slice(2).toLowerCase());
  } catch {
    return false;
  }
}

export function isBenignZeroTransferProbeFailure(err: unknown): boolean {
  const message = String(err).toLowerCase();
  return (
    message.includes("transfer amount must be greater than zero") ||
    message.includes("transfer amount must be greater than 0") ||
    message.includes("transfer amount should be greater than zero") ||
    message.includes("transfer amount should be greater than 0") ||
    message.includes("amount must be greater than zero") ||
    message.includes("amount must be greater than 0") ||
    message.includes("amount should be greater than zero") ||
    message.includes("amount should be greater than 0")
  );
}

export async function evaluateHoneypotRisk(tokenAddress: string, chain: string): Promise<HoneypotRiskResult> {
  if (chain === "solana") return evaluateSolanaHoneypotRisk(tokenAddress);
  // This check is bytecode/ABI probing — an EVM-only mechanism. Any other
  // not-yet-implemented chain fails closed rather than silently skipping: a
  // permanent reject here, not a retried InconclusiveError, since no future
  // retry will make an unimplemented chain's check exist.
  if (chain !== config.targetChainId) {
    return { passed: false, reasons: [`honeypot check not yet implemented for chain "${chain}"`], flags: ["CHAIN_NOT_SUPPORTED"] };
  }
  if (!tradingConfig.honeypotBytecodeCheckEnabled) return { passed: true, reasons: ["honeypot bytecode check disabled"], flags: [] };

  const client = getPublicClient();
  const flags: string[] = [];
  let bytecode: string | undefined;
  try {
    bytecode = await client.getCode({ address: tokenAddress as `0x${string}` });
  } catch (err) {
    // getCode only ever throws on an RPC/network problem — it returns "0x"
    // (handled below, not here) rather than throwing for a real address with
    // no code. Never proof of a honeypot, so this must not be a permanent
    // reject: throwing lets entryMonitor.ts's transient-infra handling retry
    // it with a cooldown instead of killing the candidate outright.
    logger.warn({ tokenAddress, err: String(err) }, "honeypot risk check could not read bytecode — inconclusive, will retry");
    throw new HoneypotCheckInconclusiveError(`couldn't read token bytecode: ${String(err).slice(0, 180)}`);
  }
  if (!bytecode || bytecode === "0x") return { passed: false, reasons: ["token address has no bytecode"], flags: ["NO_BYTECODE"] };

  for (const [category, signatures] of Object.entries(HONEYPOT_SIGNATURES)) {
    const matches = signatures.filter((sig) => selectorPresent(bytecode!, sig));
    if (matches.length > 0) flags.push(`${category}: ${matches.join(", ")}`);
  }

  if (isWalletConfigured()) {
    try {
      await client.simulateContract({
        address: tokenAddress as `0x${string}`,
        abi: TRANSFER_ABI,
        functionName: "transfer",
        args: [PROBE_RECIPIENT, 0n],
        account: getWalletAddress(),
      });
    } catch (err) {
      if (isBenignZeroTransferProbeFailure(err)) {
        flags.push("zero-value wallet transfer probe skipped: token rejects zero-amount transfers");
      } else if (isLikelyInfraError(err)) {
        // A network/RPC failure prevented the simulation from ever running —
        // not evidence the contract itself blocks transfers. Same reasoning
        // as the getCode catch above: retry, don't reject.
        logger.warn({ tokenAddress, err: String(err) }, "honeypot transfer simulation hit an infra error — inconclusive, will retry");
        throw new HoneypotCheckInconclusiveError(`zero-value transfer simulation infra failure: ${String(err).slice(0, 180)}`);
      } else {
        flags.push(`zero-value wallet transfer simulation failed before buy: ${String(err).slice(0, 180)}`);
      }
    }
  }

  const hardFlags = flags.filter((flag) => flag.startsWith("blacklist:") || flag.includes("transfer simulation failed"));
  if (hardFlags.length > 0) {
    return {
      passed: false,
      reasons: hardFlags.map((flag) => `honeypot risk: ${flag}`),
      flags,
    };
  }

  const softFlags = flags.filter((flag) => flag.startsWith("tradingControl:") || flag.startsWith("transferLimits:"));
  if (softFlags.length >= 2) {
    return {
      passed: false,
      reasons: [`honeypot risk: multiple sell/transfer-control selectors present (${softFlags.join("; ")})`],
      flags,
    };
  }

  return { passed: true, reasons: flags.length ? [`honeypot scan passed with non-blocking flags: ${flags.join("; ")}`] : ["honeypot scan passed"], flags };
}
