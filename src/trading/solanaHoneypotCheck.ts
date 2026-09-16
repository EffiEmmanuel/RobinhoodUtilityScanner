import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, getTransferFeeConfig, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { config } from "../config";
import { logger } from "../logger";
import { tradingConfig } from "./config";
import { HoneypotCheckInconclusiveError, type HoneypotRiskResult } from "./honeypotTypes";

let connection: Connection | undefined;
function getSolanaConnection(): Connection {
  if (!config.solanaRpcUrl) throw new Error("SOLANA_RPC_URL is not set — cannot run the Solana honeypot check");
  if (!connection) connection = new Connection(config.solanaRpcUrl, "confirmed");
  return connection;
}

// A transfer fee this high or above counts as a soft flag on its own —
// mirrors the EVM check treating an active tax-control selector as a
// soft, not automatic-reject, signal. Below this, a small fee alone (e.g.
// a normal creator-fee token) doesn't count.
const HIGH_TRANSFER_FEE_BASIS_POINTS = 500; // 5%

/**
 * Solana counterpart to honeypotCheck.ts's evaluateHoneypotRisk. SPL tokens
 * have no bytecode to scan — this reads the mint account's own authorities
 * and (Token-2022 only) transfer-fee extension instead, the direct analogs
 * of the EVM check's blacklist/tax-control bytecode signatures:
 *  - an active freeze authority is a hard fail: the issuer can freeze any
 *    holder's token account outright at any time, the closest Solana
 *    equivalent of an EVM blacklist() function and just as unambiguous a
 *    rug vector on its own.
 *  - an active mint authority (issuer can inflate supply at will) and a high
 *    live Token-2022 transfer fee are soft flags — mint authority in
 *    particular is routine on pump.fun-style bonding-curve launches
 *    pre-migration (owned by the launchpad program, not an arbitrary human
 *    key), so it alone isn't inherently a rug; two or more soft flags
 *    together reject, mirroring the EVM check's soft-flag threshold.
 * No PRE-buy zero-value transfer probe here (unlike the EVM check's
 * zero-value simulateContract call) — a pre-buy SPL probe would need to
 * simulate from an ATA the wallet may not hold yet, a different and smaller
 * signal than the POST-buy check. The POST-buy equivalent (real-balance
 * transferChecked simulation, the stronger of the EVM check's two signals)
 * does now exist: see executionFacade.ts's canWalletTransferToken ->
 * live/solana/executionProvider.ts's canSolanaWalletTransferToken. Mint/
 * freeze-authority inspection here is still the primary signal real Solana
 * rug-detection tools rely on regardless.
 */
export async function evaluateSolanaHoneypotRisk(mintAddress: string): Promise<HoneypotRiskResult> {
  if (!tradingConfig.honeypotBytecodeCheckEnabled) return { passed: true, reasons: ["honeypot check disabled"], flags: [] };

  const conn = getSolanaConnection();
  const mintPubkey = new PublicKey(mintAddress);

  let ownerProgram: PublicKey | undefined;
  try {
    const accountInfo = await conn.getAccountInfo(mintPubkey);
    ownerProgram = accountInfo?.owner;
  } catch (err) {
    // Same rationale as honeypotCheck.ts's getCode catch: an RPC/network
    // problem proves nothing about the token, so this must be retried, not
    // treated as a permanent reject.
    logger.warn({ mintAddress, err: String(err) }, "solana honeypot check could not read mint account — inconclusive, will retry");
    throw new HoneypotCheckInconclusiveError(`couldn't read mint account: ${String(err).slice(0, 180)}`);
  }

  if (!ownerProgram) {
    return { passed: false, reasons: ["mint address has no on-chain account"], flags: ["NO_MINT_ACCOUNT"] };
  }
  const isToken2022 = ownerProgram.equals(TOKEN_2022_PROGRAM_ID);
  if (!isToken2022 && !ownerProgram.equals(TOKEN_PROGRAM_ID)) {
    return { passed: false, reasons: ["address is not owned by the SPL Token or Token-2022 program"], flags: ["NOT_AN_SPL_MINT"] };
  }

  let mint;
  try {
    mint = await getMint(conn, mintPubkey, "confirmed", isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
  } catch (err) {
    logger.warn({ mintAddress, err: String(err) }, "solana honeypot check could not parse mint data — inconclusive, will retry");
    throw new HoneypotCheckInconclusiveError(`couldn't parse mint account: ${String(err).slice(0, 180)}`);
  }

  const flags: string[] = [];
  if (mint.freezeAuthority !== null) {
    flags.push(`freezeAuthority: active (${mint.freezeAuthority.toBase58()}) — issuer can freeze any holder's tokens at will`);
  }
  if (mint.mintAuthority !== null) {
    flags.push(`mintAuthority: active (${mint.mintAuthority.toBase58()}) — supply can be inflated post-launch`);
  }
  if (isToken2022) {
    try {
      const feeConfig = getTransferFeeConfig(mint);
      if (feeConfig && feeConfig.newerTransferFee.transferFeeBasisPoints >= HIGH_TRANSFER_FEE_BASIS_POINTS) {
        flags.push(`transferFee: ${(feeConfig.newerTransferFee.transferFeeBasisPoints / 100).toFixed(2)}% active transfer fee`);
      }
    } catch {
      // Extension absent or unparseable — not itself a signal either way.
    }
  }

  const hardFlags = flags.filter((f) => f.startsWith("freezeAuthority:"));
  if (hardFlags.length > 0) {
    return { passed: false, reasons: hardFlags.map((f) => `honeypot risk: ${f}`), flags };
  }

  const softFlags = flags.filter((f) => f.startsWith("mintAuthority:") || f.startsWith("transferFee:"));
  if (softFlags.length >= 2) {
    return { passed: false, reasons: [`honeypot risk: multiple risk signals present (${softFlags.join("; ")})`], flags };
  }

  return { passed: true, reasons: flags.length ? [`honeypot scan passed with non-blocking flags: ${flags.join("; ")}`] : ["honeypot scan passed"], flags };
}
