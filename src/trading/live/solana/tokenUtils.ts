import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TokenAccountNotFoundError } from "@solana/spl-token";

/** Mirrors solanaHoneypotCheck.ts's mint-owner lookup — SPL tokens can live
 * under either the legacy Token program or Token-2022, and every
 * account-derivation/read call needs to target the right one. */
export async function resolveTokenProgramId(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} has no on-chain account`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`${mint.toBase58()} is not owned by the SPL Token or Token-2022 program`);
}

/** Solana counterpart to ../tokenUtils.ts's getTokenDecimals/getTokenBalance
 * — SPL balances live in a derived Associated Token Account (ATA), not on
 * the mint or the owner directly, so reading a balance is always
 * derive-then-read rather than a single contract call the way ERC20's
 * balanceOf is. */
export async function getSolanaTokenBalance(connection: Connection, mint: PublicKey, owner: PublicKey): Promise<bigint> {
  const programId = await resolveTokenProgramId(connection, mint);
  const ata = getAssociatedTokenAddressSync(mint, owner, false, programId);
  try {
    const account = await getAccount(connection, ata, "confirmed", programId);
    return account.amount;
  } catch (err) {
    // No ATA yet is not an error — it just means a zero balance (the wallet
    // has never held this token). Anything else is a real read failure.
    if (err instanceof TokenAccountNotFoundError) return 0n;
    throw err;
  }
}

export async function getSolanaMintDecimals(connection: Connection, mint: PublicKey): Promise<number> {
  const programId = await resolveTokenProgramId(connection, mint);
  const info = await connection.getParsedAccountInfo(mint);
  const data = info.value?.data;
  if (!data || !("parsed" in data)) throw new Error(`could not parse mint ${mint.toBase58()} (program ${programId.toBase58()})`);
  const decimals = (data.parsed as { info?: { decimals?: number } })?.info?.decimals;
  if (decimals === undefined) throw new Error(`mint ${mint.toBase58()} parsed data has no decimals field`);
  return decimals;
}

export function deriveAta(mint: PublicKey, owner: PublicKey, tokenProgramId: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, tokenProgramId);
}
