import { VersionedTransaction, TransactionMessage, PublicKey, Keypair, PACKET_DATA_SIZE } from "@solana/web3.js";
import { createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { logger } from "../../../logger";
import { config } from "../../../config";
import { getJupiterQuote, getJupiterSwapTransaction, SOL_MINT, type JupiterQuote } from "./jupiterClient";
import { getSolanaConnection, getSolanaWalletAddress, getSolanaWalletPublicKey, isSolanaWalletConfigured, signAndSendSolanaTransaction, getSolanaWalletBalanceSol } from "./wallet";
import { deriveAta, resolveTokenProgramId } from "./tokenUtils";

/**
 * Solana counterpart to ../liveExecutionProvider.ts. The EVM version quotes
 * via an on-chain eth_call simulation against a known router/pool because
 * Uniswap v4 has no aggregator to ask; Jupiter IS the aggregator here, so
 * getSolanaLiveQuote just asks it directly — no manual pool discovery.
 */

export interface SolanaLiveQuote {
  outAmount: bigint;
  priceImpactPercent: number;
  raw: JupiterQuote;
}

/** Real quote via Jupiter's API — simulated against Jupiter's own live route
 * state, never a state change. */
export async function getSolanaLiveQuote(mintAddress: string, isBuy: boolean, amountIn: bigint, slippageBps: number): Promise<SolanaLiveQuote | undefined> {
  const [inputMint, outputMint] = isBuy ? [SOL_MINT, mintAddress] : [mintAddress, SOL_MINT];
  const quote = await getJupiterQuote(inputMint, outputMint, amountIn, slippageBps);
  if (!quote) return undefined;
  return { outAmount: quote.outAmount, priceImpactPercent: quote.priceImpactPercent, raw: quote };
}

export interface SolanaSwapResult {
  signature: string;
  amountIn: bigint;
  amountOut: bigint;
  feeLamports?: number;
}

async function getTransactionFeeLamports(signature: string): Promise<number | undefined> {
  const conn = getSolanaConnection();
  const tx = await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
  return tx?.meta?.fee;
}

/** Whether a built transaction fits Solana's 1232-byte packet, signatures
 * included. web3.js only bounds the message: a bigger message throws a
 * RangeError ("encoding overruns Uint8Array"), but a message that fits can
 * still make an oversized transaction once the signatures are added. */
export function fitsInOneTransaction(tx: VersionedTransaction): boolean {
  try {
    return tx.serialize().length <= PACKET_DATA_SIZE;
  } catch (err) {
    if (err instanceof RangeError) return false;
    throw err;
  }
}

// Route-size caps to try, in order: Jupiter's default first, then simpler
// routes. Confirmed live 2026-09-24: Jupiter returned a buy route too big
// for one transaction, which failed at signing with "encoding overruns
// Uint8Array". Nothing was sent, but the candidate was rejected for good,
// and the same thing on a sell would leave a position with no exit.
const MAX_ACCOUNTS_ATTEMPTS = [undefined, 48, 40, 32];

interface FittingSwap {
  quote: JupiterQuote;
  tx: VersionedTransaction;
  maxAccounts: number | undefined;
}

/** The first route, from Jupiter's default down through tighter caps,
 * whose transaction fits in one packet. Undefined when none does. Throws only
 * when there is no route at all. */
export async function buildFittingSwap(inputMint: string, outputMint: string, amount: bigint, slippageBps: number, userPublicKey: string): Promise<FittingSwap | undefined> {
  const mint = inputMint === SOL_MINT ? outputMint : inputMint;
  for (const maxAccounts of MAX_ACCOUNTS_ATTEMPTS) {
    const quote = await getJupiterQuote(inputMint, outputMint, amount, slippageBps, maxAccounts);
    if (!quote) {
      if (maxAccounts === undefined) throw new Error(`no jupiter quote available for ${mint}`);
      continue; // no route that simple — try the next cap
    }
    const swapTxBase64 = await getJupiterSwapTransaction(quote, userPublicKey);
    if (!swapTxBase64) throw new Error("jupiter did not return a swap transaction");
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTxBase64, "base64"));
    if (fitsInOneTransaction(tx)) return { quote, tx, maxAccounts };
    logger.warn({ mint, maxAccounts: maxAccounts ?? "default" }, "jupiter route too large for one transaction — asking for a simpler route");
  }
  return undefined;
}

async function executeSwap(inputMint: string, outputMint: string, amount: bigint, slippageBps: number): Promise<SolanaSwapResult> {
  if (!isSolanaWalletConfigured()) throw new Error("SOLANA_WALLET_PRIVATE_KEY is not set — cannot execute a live solana swap");
  const userPublicKey = getSolanaWalletAddress();
  const mint = inputMint === SOL_MINT ? outputMint : inputMint;

  const swap = await buildFittingSwap(inputMint, outputMint, amount, slippageBps, userPublicKey);
  if (!swap) throw new Error(`jupiter has no route for ${mint} that fits in one transaction`);
  // A buy that only fit after capping the route is a token whose routes run
  // long, so its sell might not fit at all. Check before buying, not after.
  if (inputMint === SOL_MINT && swap.maxAccounts !== undefined) {
    const exit = await buildFittingSwap(outputMint, SOL_MINT, swap.quote.outAmount, slippageBps, userPublicKey);
    if (!exit) throw new Error(`not buying ${mint}: no sell route for it fits in one transaction`);
  }

  const signature = await signAndSendSolanaTransaction(swap.tx);
  // Best-effort — feeds gasCostUsd for P&L accounting, not itself a
  // correctness gate the way the swap confirmation above is.
  const feeLamports = await getTransactionFeeLamports(signature).catch((err) => {
    logger.warn({ signature, err: String(err) }, "could not read solana transaction fee — gasCostUsd will be unavailable for this fill");
    return undefined;
  });

  return { signature, amountIn: swap.quote.inAmount, amountOut: swap.quote.outAmount, feeLamports };
}

/** Buy: pay with native SOL. Jupiter's swap-transaction builder wraps/unwraps
 * SOL and creates any missing destination ATA itself — no separate
 * approval step exists on Solana the way EVM needs Permit2. */
export async function executeSolanaLiveBuy(mintAddress: string, amountInLamports: bigint, maxSlippageBps: number): Promise<SolanaSwapResult> {
  return executeSwap(SOL_MINT, mintAddress, amountInLamports, maxSlippageBps);
}

export async function executeSolanaLiveSell(mintAddress: string, tokenAmountRaw: bigint, maxSlippageBps: number): Promise<SolanaSwapResult> {
  return executeSwap(mintAddress, SOL_MINT, tokenAmountRaw, maxSlippageBps);
}

export async function getSolanaWalletGasBalanceSol(): Promise<number> {
  return getSolanaWalletBalanceSol();
}

/**
 * Solana counterpart to executionFacade.ts's canWalletTransferToken — the
 * post-buy reconciliation check that catches a honeypot/Token-2022
 * transfer-hook that only blocks real holder transfers while leaving
 * quoting (isSellable/getSolanaLiveQuote) untouched. Unlike the mint/
 * freeze-authority checks in solanaHoneypotCheck.ts (static account fields),
 * this needs a real signed-transfer simulation because a transfer hook's
 * logic is arbitrary program code, not a declared authority.
 *
 * Simulates (never submits) an SPL transferChecked from the wallet's own ATA
 * to a fresh, unused ATA — the destination never needs to exist on-chain
 * beforehand since nothing is actually sent, so no hardcoded "burn address"
 * is needed either (mirrors the EVM check's "any address works here, this
 * never sends a transaction" comment). sigVerify: false means this doesn't
 * need the wallet's private key, only its public key as fee payer.
 */
export async function canSolanaWalletTransferToken(mintAddress: string, tokenAmount: number): Promise<boolean> {
  if (tokenAmount <= 0) return true;
  const conn = getSolanaConnection();
  const wallet = getSolanaWalletPublicKey();
  const mint = new PublicKey(mintAddress);

  try {
    const programId = await resolveTokenProgramId(conn, mint);
    const mintInfo = await conn.getParsedAccountInfo(mint);
    const data = mintInfo.value?.data;
    const decimals = data && "parsed" in data ? ((data.parsed as { info?: { decimals?: number } })?.info?.decimals ?? 0) : 0;
    const amountRaw = BigInt(Math.floor(tokenAmount * 10 ** decimals));

    const sourceAta = deriveAta(mint, wallet, programId);
    const throwawayDestination = Keypair.generate().publicKey;
    const destAta = deriveAta(mint, throwawayDestination, programId);

    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: wallet,
      recentBlockhash: blockhash,
      instructions: [
        createAssociatedTokenAccountIdempotentInstruction(wallet, destAta, throwawayDestination, mint, programId),
        createTransferCheckedInstruction(sourceAta, mint, destAta, wallet, amountRaw, decimals, [], programId),
      ],
    }).compileToV0Message();

    const sim = await conn.simulateTransaction(new VersionedTransaction(message), { sigVerify: false });
    if (sim.value.err) {
      logger.warn({ mintAddress, err: JSON.stringify(sim.value.err) }, "wallet cannot transfer this token at all — likely a honeypot/transfer-hook that blocks real holder sales");
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ mintAddress, err: String(err) }, "solana transfer-simulation probe failed");
    return false;
  }
}

/**
 * Deliberately its own gate, not tradingConfig.mode (which today only
 * governs the EVM path) — see wallet.ts and config.ts's solanaTradingEnabled
 * doc comments for why. Chain-scoped so EVM can run LIVE while Solana stays
 * off, or vice versa, without one accidentally flipping the other.
 */
export function isSolanaLiveModeReady(): boolean {
  return config.solanaTradingEnabled && isSolanaWalletConfigured();
}
