import { Connection, Keypair, VersionedTransaction, PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import { config } from "../../../config";
import { logger } from "../../../logger";

/**
 * Solana counterpart to ../wallet.ts (§20 Wallet Security Requirements
 * applies here too) — this is the ONLY module allowed to read
 * SOLANA_WALLET_PRIVATE_KEY. Never log it, never return it, never expose it
 * through an API response. A fully separate keypair and secret from the EVM
 * wallet's BOT_WALLET_PRIVATE_KEY — a Solana-side bug or rug must never be
 * able to touch EVM capital, and vice versa.
 *
 * NOT wired into portfolio.ts's cash/circuit-breaker accounting (see
 * getPortfolioState/checkCircuitBreakers) — that system is one global
 * EVM-only ledger today. Flipping SOLANA_TRADING_ENABLED=true makes live
 * Solana trades reachable without the shared daily-loss/consecutive-loss/
 * equity breakers ever seeing Solana positions. Isolating that is a
 * deliberately deferred follow-up, not an oversight — see the project plan.
 */

let keypair: Keypair | undefined;

function getKeypair(): Keypair {
  if (keypair) return keypair;
  const key = process.env.SOLANA_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("SOLANA_WALLET_PRIVATE_KEY is not set — live Solana execution cannot sign anything without it");
  // Accepts either a base58-encoded secret key (the format Solana CLI/most
  // wallets export) or a JSON array of bytes (e.g. `[12,34,...]`, the format
  // solana-keygen writes to a file) — same dual-format leniency real Solana
  // tooling expects, so the key can be pasted in whichever form is on hand.
  const trimmed = key.trim();
  const secretKey = trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed);
  keypair = Keypair.fromSecretKey(secretKey);
  return keypair;
}

export function isSolanaWalletConfigured(): boolean {
  return Boolean(process.env.SOLANA_WALLET_PRIVATE_KEY);
}

/** Safe to log/return anywhere — this is the whole reason this function exists. */
export function getSolanaWalletAddress(): string {
  return getKeypair().publicKey.toBase58();
}

let connection: Connection | undefined;
export function getSolanaConnection(): Connection {
  if (!config.solanaRpcUrl) throw new Error("SOLANA_RPC_URL is not set — cannot reach the Solana network");
  if (!connection) connection = new Connection(config.solanaRpcUrl, "confirmed");
  return connection;
}

// §28-equivalent allowlist, enforced at the ONE place that actually signs, as
// defense-in-depth against a bug anywhere upstream building a transaction
// that touches a program that was never vetted. Every instruction in a
// Jupiter swap transaction must be owned by one of these — the aggregator
// itself, token-account setup, or the System Program (for SOL wrapping).
// Program IDs sourced from the SDKs themselves (@solana/web3.js,
// @solana/spl-token) rather than hand-typed, except Jupiter's — that one
// isn't exported by any installed package. Confirmed correct via web search
// against Solscan/Jupiter's own docs as of 2026-09-16 (Jupiter Aggregator
// v6, the current production deployment).
const JUPITER_V6_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ALLOWED_PROGRAM_IDS = new Set([
  JUPITER_V6_PROGRAM_ID,
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
  ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  SystemProgram.programId.toBase58(),
  ComputeBudgetProgram.programId.toBase58(),
]);

function assertTransactionAllowed(tx: VersionedTransaction): void {
  const keys = tx.message.getAccountKeys();
  for (const ix of tx.message.compiledInstructions) {
    const programId = keys.get(ix.programIdIndex);
    if (!programId) throw new Error("refusing to sign: transaction references an account index outside its own key table");
    if (!ALLOWED_PROGRAM_IDS.has(programId.toBase58())) {
      throw new Error(`refusing to sign: instruction targets ${programId.toBase58()}, which is not in the program allowlist`);
    }
  }
}

// Same nonce-safety rationale as ../wallet.ts's sendQueue — a single process,
// but BUY and SELL can be triggered from independent loops that could
// otherwise race. Solana has no account nonce, but concurrent sends still
// need serializing to avoid two transactions racing to spend the same SOL/
// token balance against a blockhash snapshot taken at slightly different
// times.
let sendQueue: Promise<unknown> = Promise.resolve();

/**
 * Signs and submits an already-built (unsigned) VersionedTransaction — the
 * only function in this module that actually signs. Callers build the
 * transaction (see jupiterClient.ts/executionProvider.ts); this only vets,
 * signs, sends, and confirms it.
 */
export function signAndSendSolanaTransaction(tx: VersionedTransaction): Promise<string> {
  assertTransactionAllowed(tx);
  const task = sendQueue.then(async () => {
    const conn = getSolanaConnection();
    const kp = getKeypair();
    tx.sign([kp]);
    const signature = await conn.sendTransaction(tx, { maxRetries: 3 });
    const latestBlockhash = await conn.getLatestBlockhash("confirmed");
    const confirmation = await conn.confirmTransaction({ signature, ...latestBlockhash }, "confirmed");
    if (confirmation.value.err) {
      throw new Error(`solana transaction ${signature} confirmed with an error: ${JSON.stringify(confirmation.value.err)}`);
    }
    logger.info({ signature, from: kp.publicKey.toBase58() }, "signed and confirmed live solana transaction");
    return signature;
  });
  sendQueue = task.catch(() => undefined);
  return task;
}

export async function getSolanaWalletBalanceSol(): Promise<number> {
  const conn = getSolanaConnection();
  const lamports = await conn.getBalance(getKeypair().publicKey);
  return lamports / 1e9;
}

export function getSolanaWalletPublicKey(): PublicKey {
  return getKeypair().publicKey;
}
