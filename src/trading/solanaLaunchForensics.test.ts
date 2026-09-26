import { describe, it, expect } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  findAnchorAt,
  findFunder,
  getSolanaLaunchForensics,
  isProgramOwned,
  toLaunchTx,
  DEFAULT_SOLANA_FORENSICS_OPTIONS,
  type ParsedTransaction,
  type SolanaRpc,
} from "./solanaLaunchForensics";
import { evaluateLaunchForensics } from "./launchForensics";

const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const wallet = () => Keypair.generate().publicKey.toBase58();
const curveOf = (mint: string) => PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP)[0].toBase58();

function curveData(creator: string, complete: boolean): [string, string] {
  const buf = Buffer.alloc(81);
  buf[48] = complete ? 1 : 0;
  new PublicKey(creator).toBuffer().copy(buf, 49);
  return [buf.toString("base64"), "base64"];
}

/** A parsed transaction where each listed owner's balance of `mint` goes from pre to post. */
function tx(signature: string, slot: number, feePayer: string, mint: string, balances: { owner: string; pre?: bigint; post?: bigint }[], instructions: ParsedTransaction["transaction"]["message"]["instructions"] = []): ParsedTransaction {
  const keys = [feePayer, ...balances.map((_, i) => `acct${i}`)].map((pubkey) => ({ pubkey }));
  const entries = (side: "pre" | "post") =>
    balances.flatMap((b, i) => (b[side] === undefined ? [] : [{ accountIndex: i + 1, mint, owner: b.owner, uiTokenAmount: { amount: b[side]!.toString() } }]));
  return {
    slot,
    blockTime: 1_000_000 + slot,
    transaction: { signatures: [signature], message: { accountKeys: keys, instructions } },
    meta: { err: null, preTokenBalances: entries("pre"), postTokenBalances: entries("post"), innerInstructions: [] },
  };
}

const transferIx = (source: string, destination: string) => ({ program: "system", parsed: { type: "transfer", info: { source, destination, lamports: 1_000_000_000 } } });
const sig = (signature: string, slot: number) => ({ signature, slot, blockTime: 1_000_000 + slot, err: null });

describe("isProgramOwned", () => {
  it("separates program-derived addresses from people's wallets", () => {
    expect(isProgramOwned(curveOf(wallet()))).toBe(true);
    expect(isProgramOwned(wallet())).toBe(false);
  });
});

describe("toLaunchTx", () => {
  it("nets each owner's balance change for the mint and marks pool accounts", () => {
    const mint = wallet();
    const buyer = wallet();
    const curve = curveOf(mint);
    const t = toLaunchTx(
      tx("s", 5, buyer, mint, [
        { owner: buyer, post: 700n },
        { owner: curve, pre: 10_000n, post: 9_300n },
      ]),
      mint
    );
    expect(t.feePayer).toBe(buyer);
    expect(t.moves).toHaveLength(2);
    expect(t.moves).toEqual(
      expect.arrayContaining([
        { owner: buyer, delta: 700n, post: 700n, ownerIsProgram: false },
        { owner: curve, delta: -700n, post: 9_300n, ownerIsProgram: true },
      ])
    );
  });

  it("reads a closed account (no post balance) as selling everything, and ignores other mints", () => {
    const mint = wallet();
    const seller = wallet();
    const parsed = tx("s", 5, seller, mint, [{ owner: seller, pre: 500n }]);
    parsed.meta!.postTokenBalances!.push({ accountIndex: 9, mint: wallet(), owner: seller, uiTokenAmount: { amount: "1" } });
    expect(toLaunchTx(parsed, mint).moves).toEqual([{ owner: seller, delta: -500n, post: 0n, ownerIsProgram: false }]);
  });
});

describe("findFunder", () => {
  it("finds the SOL sender in the wallet's first transaction", () => {
    const w = wallet();
    const funder = wallet();
    expect(findFunder(tx("f", 1, funder, "m", [], [transferIx(funder, w)]), w)).toBe(funder);
  });

  it("falls back to whoever paid for the transaction", () => {
    const w = wallet();
    const payer = wallet();
    expect(findFunder(tx("f", 1, payer, "m", []), w)).toBe(payer);
    expect(findFunder(tx("f", 1, w, "m", []), w)).toBeUndefined();
  });
});

describe("findAnchorAt", () => {
  it("returns a signature from a block at or before asOf, skipping empty slots", async () => {
    // Slot time drifts to 0.45s; slots divisible by 7 were skipped.
    const timeOf = (slot: number) => 1_000_000 + Math.floor(slot * 0.45);
    const rpc: SolanaRpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        const slot = params[0] as number;
        if (method === "getSlot") return 10_000_000 as T;
        if (slot % 7 === 0) throw new Error(`Slot ${slot} was skipped`);
        if (method === "getBlockTime") return timeOf(slot) as T;
        if (method === "getBlock") return { signatures: [`first-${slot}`, `last-${slot}`], blockTime: timeOf(slot) } as T;
        throw new Error(method);
      },
    };
    const asOf = timeOf(6_000_000) + 0.2;
    const a = await findAnchorAt(rpc, asOf);
    expect(a.blockTime).toBeLessThanOrEqual(asOf);
    expect(asOf - a.blockTime).toBeLessThan(3);
    expect(a.signature).toBe(`last-${a.slot}`);
  });
});

/** An in-memory chain for one pump.fun launch. */
function launchScenario() {
  const mint = wallet();
  const curve = curveOf(mint);
  const deployer = wallet();
  const curveCreator = wallet();
  const funder = wallet();
  const [w1, w2, w3] = [wallet(), wallet(), wallet()];
  const priorMint = wallet();
  const priorAccount = wallet();
  const SUPPLY = 1_000_000_000n;
  const deployerAta = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(deployer), true, TOKEN_2022_PROGRAM_ID).toBase58();

  const txs = new Map<string, ParsedTransaction>([
    // Deployer creates the token and dev-buys 5%; w1 and w2 buy in the same slot (a bundle).
    ["launch", tx("launch", 500, deployer, mint, [{ owner: deployer, post: 50_000_000n }, { owner: curve, post: 950_000_000n }])],
    ["b1", tx("b1", 500, w1, mint, [{ owner: w1, post: 100_000_000n }, { owner: curve, pre: 950_000_000n, post: 850_000_000n }])],
    ["b2", tx("b2", 500, w2, mint, [{ owner: w2, post: 100_000_000n }, { owner: curve, pre: 850_000_000n, post: 750_000_000n }])],
    ["b3", tx("b3", 530, w3, mint, [{ owner: w3, post: 10_000_000n }, { owner: curve, pre: 750_000_000n, post: 740_000_000n }])],
    // Deployer dumps its whole dev buy.
    ["dump", tx("dump", 560, deployer, mint, [{ owner: deployer, pre: 50_000_000n, post: 0n }, { owner: curve, pre: 740_000_000n, post: 790_000_000n }])],
    // Funding: one wallet funded the deployer and both bundle buyers.
    ["fund-dev", tx("fund-dev", 400, funder, "none", [], [transferIx(funder, deployer)])],
    ["fund-w1", tx("fund-w1", 401, funder, "none", [], [transferIx(funder, w1)])],
    ["fund-w2", tx("fund-w2", 402, funder, "none", [], [transferIx(funder, w2)])],
  ]);

  const signatures: Record<string, ReturnType<typeof sig>[]> = {
    [curve]: [sig("dump", 560), sig("b3", 530), sig("b2", 500), sig("b1", 500), sig("launch", 500)],
    [deployerAta]: [sig("dump", 560), sig("launch", 500)],
    [deployer]: [sig("fund-dev", 400)],
    [w1]: [sig("fund-w1", 401)],
    [w2]: [sig("fund-w2", 402)],
    // w3 is a busy bot: a full page of history, so its funder stays unknown.
    [w3]: Array.from({ length: 1000 }, (_, i) => sig(`w3-${i}`, 499 - i)),
    [funder]: [sig("fund-w2", 402), sig("fund-w1", 401), sig("fund-dev", 400)],
    // The deployer's earlier launch, 10h before this one.
    [priorAccount]: [sig("prior-launch", 500 - 36_000)],
  };

  const rpc: SolanaRpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const [first, opts] = params as [string, Record<string, unknown> | undefined];
      switch (method) {
        case "getAccountInfo":
          if (first === mint) return { value: { owner: TOKEN_2022_PROGRAM_ID.toBase58() } } as T;
          if (first === curve) return { value: { owner: PUMP.toBase58(), data: curveData(curveCreator, false) } } as T;
          return { value: null } as T;
        case "getTokenSupply":
          return { value: { amount: SUPPLY.toString() } } as T;
        case "getSignaturesForAddress": {
          const all = signatures[first] ?? [];
          const before = opts?.before as string | undefined;
          const start = before ? all.findIndex((s) => s.signature === before) + 1 : 0;
          return all.slice(start, start + ((opts?.limit as number) ?? 1000)) as T;
        }
        case "getTransaction":
          return (txs.get(first) ?? null) as T;
        case "getTokenAccountsByOwner": {
          const program = (params[1] as { programId: string }).programId;
          const list = first === deployer && program === TOKEN_2022_PROGRAM_ID.toBase58() ? [{ pubkey: priorAccount, account: { data: { parsed: { info: { mint: priorMint } } } } }] : [];
          return { value: list } as T;
        }
        case "getMultipleAccounts":
          return { value: (first as unknown as string[]).map((c) => (c === curveOf(priorMint) ? { owner: PUMP.toBase58(), data: curveData(deployer, false) } : null)) } as T;
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { mint, rpc, deployer, curveCreator };
}

describe("getSolanaLaunchForensics", () => {
  it("has no default RPC, so nothing spends the prod key by accident", () => {
    // @ts-expect-error rpc is required (typecheck fails if it gets a default again)
    const call = () => getSolanaLaunchForensics("mint", undefined);
    expect(typeof call).toBe("function");
  });

  it("reads the bundle, the dev dump, the serial launcher and the shared funder from one launch", async () => {
    const { mint, rpc, deployer, curveCreator } = launchScenario();
    const f = await getSolanaLaunchForensics(mint, undefined, rpc, DEFAULT_SOLANA_FORENSICS_OPTIONS);

    expect(f.unknowns).toEqual([]);
    expect(f.launchpad).toBe("pumpfun");
    expect(f.creator).toBe(deployer);
    expect(f.curveCreator).toBe(curveCreator);
    expect(f.earlyWindowComplete).toBe(true);
    expect(f.early).toMatchObject({ creatorInitialBuyPct: 5, buyersSeen: 3, first20BuyerSharePct: 21, launchSlotBuyerCount: 2, launchSlotBuySharePct: 20 });
    expect(f.creatorHolding).toEqual({ peakPct: 5, currentPct: 0, soldPctOfPeak: 100, sellTxCount: 1 });
    expect(f.creatorHoldingComplete).toBe(true);
    expect(f.creatorPriorTxCount).toBe(1);
    expect(f.creatorLaunches).toEqual({ priorLaunches: 1, priorGraduated: 0, priorDead: 1, launchesPrior24h: 1 });
    expect(f.funding).toMatchObject({ creatorLinkedBuyers: 2, creatorLinkedSharePct: 20, largestFunderCluster: 2, buyersWithKnownFunder: 2 });
  });

  it("marks the early window UNKNOWN when the launch is too far back, and the gate lets it through", async () => {
    const { mint } = launchScenario();
    const endless: SolanaRpc = {
      async call<T>(method: string, params: unknown[]): Promise<T> {
        if (method === "getAccountInfo") return { value: null } as T;
        if (method === "getTokenSupply") return { value: { amount: "1000" } } as T;
        if (method === "getSignaturesForAddress") return Array.from({ length: 1000 }, (_, i) => sig(`s${String(params[0]).slice(0, 4)}${i}`, 10_000 - i)) as T;
        throw new Error(`unexpected ${method}`);
      },
    };
    const f = await getSolanaLaunchForensics(mint, undefined, endless, { ...DEFAULT_SOLANA_FORENSICS_OPTIONS, maxHistoryPages: 2 });
    expect(f.launchpad).toBe("other");
    expect(f.early).toBeUndefined();
    expect(f.unknowns).toEqual(["early buyers: launch is more than 2000 transactions back"]);
    const verdict = evaluateLaunchForensics(f, { maxFirst20BuyerSharePct: 1, maxLaunchSlotBuySharePct: 1, maxCreatorSoldPctOfPeak: 1, maxCreatorPriorDeadLaunches: 1, maxLinkedBuyerSharePct: 1 });
    expect(verdict.passed).toBe(true);
  });
});
