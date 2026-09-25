import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { getSolanaConnection, getSolanaWalletPublicKey } from "../src/trading/live/solana/wallet";
import { closeSolanaTokenAccount } from "../src/trading/live/solana/executionProvider";

/**
 * One-off, human-run: closes the bot's Solana token accounts that hold no
 * tokens, returning their rent to the wallet. Until the bot started closing
 * the account after each full exit, every first buy of a mint left one
 * behind (~0.0015 SOL each; 4 of them, ~0.006 SOL, on 2026-09-25).
 *
 * Only a zero-balance account is ever touched: nothing is sold or burned,
 * and every close is simulated before it's signed.
 *
 * Dry run (the default) lists every token account, simulates each close and
 * sends nothing:
 *   railway run -- npx tsx scripts/close-empty-solana-token-accounts.ts
 * Then, to actually close them:
 *   railway run -- npx tsx scripts/close-empty-solana-token-accounts.ts --execute
 *
 * Needs SOLANA_RPC_URL and SOLANA_WALLET_PRIVATE_KEY. Writes nothing to the
 * database: this rent was never booked as a trade cost, so the refund only
 * shows up in the wallet balance the dashboard's equity already reads.
 */
async function main() {
  const execute = process.argv.includes("--execute");
  const conn = getSolanaConnection();
  const owner = getSolanaWalletPublicKey();
  console.log(`${execute ? "EXECUTE" : "DRY RUN (pass --execute to send)"} — wallet ${owner.toBase58()}`);

  let refundLamports = 0;
  let closable = 0;
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const { value } = await conn.getTokenAccountsByOwner(owner, { programId }, "confirmed");
    for (const { pubkey, account: info } of value) {
      const account = unpackAccount(pubkey, info, programId);
      const label = `${pubkey.toBase58()} (mint ${account.mint.toBase58()}, ${info.lamports} lamports)`;
      if (account.amount > 0n) {
        console.log(`  keep   ${label}: holds ${account.amount} raw units`);
        continue;
      }
      const result = await closeSolanaTokenAccount(pubkey, programId, { dryRun: !execute });
      if (result.status === "skipped") {
        console.log(`  skip   ${label}: ${result.reason}`);
        continue;
      }
      closable++;
      refundLamports += result.refundLamports;
      console.log(result.status === "closed" ? `  closed ${label}: tx ${result.signature}` : `  would close ${label}`);
    }
  }
  console.log(`${execute ? "Closed" : "Would close"} ${closable} account(s), ${refundLamports} lamports (${(refundLamports / 1e9).toFixed(6)} SOL) back to the wallet.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
