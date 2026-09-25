import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, type Account } from "@solana/spl-token";
import { planTokenAccountClose, rentDepositedLamports } from "./executionProvider";
import { sellAmountRaw } from "./tokenUtils";

const owner = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

function account(overrides: Partial<Account> = {}): Account {
  return {
    address: Keypair.generate().publicKey,
    mint,
    owner,
    amount: 0n,
    delegate: null,
    delegatedAmount: 0n,
    isInitialized: true,
    isFrozen: false,
    isNative: false,
    rentExemptReserve: null,
    closeAuthority: null,
    tlvData: Buffer.alloc(0),
    ...overrides,
  };
}

// A Token-2022 TransferFeeAmount extension entry: type 2, length 8, the
// withheld amount as a little-endian u64.
function withheldTlv(amount: bigint): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt16LE(2, 0);
  buf.writeUInt16LE(8, 2);
  buf.writeBigUInt64LE(amount, 4);
  return buf;
}

function programIdsOf(plan: ReturnType<typeof planTokenAccountClose>): string[] {
  if ("skipReason" in plan) throw new Error(plan.skipReason);
  return plan.instructions.map((ix) => ix.programId.toBase58());
}

describe("planTokenAccountClose", () => {
  it("closes an empty legacy SPL account with a single instruction", () => {
    const plan = planTokenAccountClose(account(), owner, TOKEN_PROGRAM_ID);
    expect(programIdsOf(plan)).toEqual([TOKEN_PROGRAM_ID.toBase58()]);
  });

  it("closes an empty Token-2022 account with no withheld fees with a single instruction", () => {
    const plan = planTokenAccountClose(account({ tlvData: withheldTlv(0n) }), owner, TOKEN_2022_PROGRAM_ID);
    expect(programIdsOf(plan)).toEqual([TOKEN_2022_PROGRAM_ID.toBase58()]);
  });

  it("harvests withheld Token-2022 transfer fees to the mint before closing", () => {
    const plan = planTokenAccountClose(account({ tlvData: withheldTlv(42n) }), owner, TOKEN_2022_PROGRAM_ID);
    if ("skipReason" in plan) throw new Error(plan.skipReason);
    expect(plan.instructions).toHaveLength(2);
    // Harvest first (writes the mint), then close.
    expect(plan.instructions[0].keys.some((k) => k.pubkey.equals(mint) && k.isWritable)).toBe(true);
    expect(plan.instructions[1].keys[1].pubkey.equals(owner)).toBe(true); // rent goes to the wallet
  });

  it("never touches an account that still holds tokens", () => {
    const plan = planTokenAccountClose(account({ amount: 1n }), owner, TOKEN_PROGRAM_ID);
    expect(plan).toEqual({ skipReason: "still holds 1 raw units" });
  });

  it("skips accounts it can't or shouldn't close", () => {
    expect("skipReason" in planTokenAccountClose(account({ isFrozen: true }), owner, TOKEN_PROGRAM_ID)).toBe(true);
    expect("skipReason" in planTokenAccountClose(account({ isNative: true }), owner, TOKEN_PROGRAM_ID)).toBe(true);
    expect("skipReason" in planTokenAccountClose(account({ owner: Keypair.generate().publicKey }), owner, TOKEN_PROGRAM_ID)).toBe(true);
    expect("skipReason" in planTokenAccountClose(account({ closeAuthority: Keypair.generate().publicKey }), owner, TOKEN_PROGRAM_ID)).toBe(true);
  });

  it("closes when the close authority is the wallet itself", () => {
    const plan = planTokenAccountClose(account({ closeAuthority: new PublicKey(owner.toBase58()) }), owner, TOKEN_PROGRAM_ID);
    expect("instructions" in plan).toBe(true);
  });
});

describe("rentDepositedLamports", () => {
  const keys = ["wallet", "ata", "pool"];

  it("is the new account's whole balance when the transaction created it", () => {
    // Real numbers from the INDEXED buy, 2026-09-24.
    expect(rentDepositedLamports(keys, [59_000_000, 0, 5], [26_850_661, 1_513_840, 5], "ata")).toBe(1_513_840);
  });

  it("is 0 when the account already existed, or isn't in the transaction", () => {
    expect(rentDepositedLamports(keys, [59_000_000, 1_513_840, 5], [26_850_661, 1_513_840, 5], "ata")).toBe(0);
    expect(rentDepositedLamports(keys, [1, 0, 5], [1, 1_513_840, 5], "other")).toBe(0);
  });
});

describe("sellAmountRaw", () => {
  it("never sells more than the wallet holds", () => {
    expect(sellAmountRaw(1_000_001n, 1_000_000n, false)).toBe(1_000_000n);
    expect(sellAmountRaw(1_000_001n, 1_000_000n, true)).toBe(1_000_000n);
  });

  it("sells a rounding-sized remainder too on a full exit, so the account ends empty", () => {
    expect(sellAmountRaw(999_950n, 1_000_000n, true)).toBe(1_000_000n);
  });

  it("leaves the remainder on a partial sell", () => {
    expect(sellAmountRaw(999_950n, 1_000_000n, false)).toBe(999_950n);
  });

  it("does not sweep more than 0.01% extra even on a full exit", () => {
    expect(sellAmountRaw(999_000n, 1_000_000n, true)).toBe(999_000n);
  });
});
