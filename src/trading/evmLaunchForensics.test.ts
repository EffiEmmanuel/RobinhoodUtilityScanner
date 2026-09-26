import { describe, it, expect } from "vitest";
import { getContractAddress, zeroAddress, type Hex } from "viem";
import { blockAt, getEvmLaunchForensics, transfersToLaunchTxs, type EvmReader, type RawLog, type TransferLog } from "./evmLaunchForensics";

const addr = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as Hex;
const topic = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");

const DEPLOYER = addr(0xd0);
const POOL = addr(0x9001);
const [A, B, C] = [addr(0xa1), addr(0xb1), addr(0xc1)];

function transfer(block: number, idx: number, hash: string, from: string, to: string, value: bigint): TransferLog {
  return { from, to, value, blockNumber: BigInt(block), logIndex: idx, transactionHash: hash };
}

describe("transfersToLaunchTxs", () => {
  it("nets each address per transaction in chain order and marks contracts", () => {
    const txs = transfersToLaunchTxs(
      [transfer(11, 0, "t2", POOL, A, 50n), transfer(10, 0, "t1", zeroAddress, DEPLOYER, 1000n), transfer(11, 1, "t2", A, B, 20n)],
      new Map([[POOL, true]]),
      new Map([["t1", DEPLOYER]])
    );
    expect(txs.map((t) => t.signature)).toEqual(["t1", "t2"]);
    expect(txs[0]).toMatchObject({ feePayer: DEPLOYER, slot: 10, moves: [{ owner: DEPLOYER, delta: 1000n, ownerIsProgram: false }] });
    expect(txs[1].moves).toEqual(
      expect.arrayContaining([
        { owner: POOL, delta: -50n, ownerIsProgram: true },
        { owner: A, delta: 30n, ownerIsProgram: false },
        { owner: B, delta: 20n, ownerIsProgram: false },
      ])
    );
  });
});

/** A small chain: blocks every 0.1s from t=1_000_000; tokens and logs as given. */
function fakeChain(opts: {
  transfers: Record<string, TransferLog[]>;
  txs: Record<string, { from: string; to: string | null; nonce: number }>;
  contracts: Set<string>;
  receipts?: Record<string, RawLog[]>;
  factoryLogs?: RawLog[];
  head?: bigint;
}): EvmReader {
  const head = opts.head ?? 10_000_000n;
  return {
    getBlockNumber: async () => head,
    getBlockTimestamp: async (b) => 1_000_000 + Math.floor(Number(b) / 10),
    async getTransfers(token, filter, fromBlock, toBlock) {
      return (opts.transfers[token.toLowerCase()] ?? []).filter(
        (l) =>
          l.blockNumber >= fromBlock &&
          l.blockNumber <= toBlock &&
          (!filter.from || l.from.toLowerCase() === filter.from.toLowerCase()) &&
          (!filter.to || l.to.toLowerCase() === filter.to.toLowerCase())
      );
    },
    getTransaction: async (hash) => opts.txs[hash],
    getReceiptLogs: async (hash) => opts.receipts?.[hash] ?? [],
    getLogs: async (_address, topics, fromBlock, toBlock) =>
      (opts.factoryLogs ?? []).filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && topics.every((t, i) => t === null || l.topics[i] === t)),
    isContract: async (addresses) => new Map(addresses.map((a) => [a.toLowerCase(), opts.contracts.has(a.toLowerCase())])),
  };
}

describe("blockAt", () => {
  it("finds the last block at or before a time", async () => {
    const reader = fakeChain({ transfers: {}, txs: {}, contracts: new Set() });
    const b = await blockAt(reader, 1_500_000);
    expect(await reader.getBlockTimestamp(b)).toBeLessThanOrEqual(1_500_000);
    expect(await reader.getBlockTimestamp(b + 10n)).toBeGreaterThan(1_500_000);
  });
});

describe("getEvmLaunchForensics", () => {
  it("has no default reader, so nothing spends the prod RPC by accident", () => {
    // @ts-expect-error reader is required (typecheck fails if it gets a default again)
    const call = () => getEvmLaunchForensics("0x1", undefined);
    expect(typeof call).toBe("function");
  });

  it("reads a direct deploy by a serial deployer: bundle, first-20 share, dead prior tokens", async () => {
    const token = getContractAddress({ from: DEPLOYER, nonce: 5n }).toLowerCase();
    const priorLive = getContractAddress({ from: DEPLOYER, nonce: 1n }).toLowerCase();
    const priorDead = getContractAddress({ from: DEPLOYER, nonce: 3n }).toLowerCase();
    const launchBlock = 5_000_000;
    const live = launchBlock + 100;
    const transfers: Record<string, TransferLog[]> = {
      [token]: [
        transfer(launchBlock, 0, "mint", zeroAddress, DEPLOYER, 1_000_000n),
        // Liquidity goes live; two wallets buy in that same block.
        transfer(live, 0, "lp", DEPLOYER, POOL, 900_000n),
        transfer(live, 1, "b1", POOL, A, 200_000n),
        transfer(live, 2, "b2", POOL, B, 150_000n),
        transfer(live + 50, 0, "b3", POOL, C, 10_000n),
      ],
      // Launched ~11h before this token; one still trades, one went quiet.
      [priorLive]: [transfer(launchBlock - 400_000, 0, "pl", zeroAddress, DEPLOYER, 1n), transfer(launchBlock + 1_000, 0, "pl2", DEPLOYER, A, 1n)],
      [priorDead]: [transfer(launchBlock - 400_000, 0, "pd", zeroAddress, DEPLOYER, 1n)],
    };
    const reader = fakeChain({
      transfers,
      txs: { mint: { from: DEPLOYER, to: null, nonce: 5 } },
      contracts: new Set([POOL.toLowerCase(), priorLive, priorDead]),
    });
    const asOf = new Date((1_000_000 + Math.floor((launchBlock + 3_000) / 10)) * 1000);
    const f = await getEvmLaunchForensics(token, asOf, reader);

    expect(f.creator).toBe(DEPLOYER.toLowerCase());
    expect(f.creatorPriorTxCount).toBe(5);
    expect(f.launchpad).toBe("direct");
    expect(f.early).toMatchObject({ buyersSeen: 3, first20BuyerSharePct: 36, launchSlotBuyerCount: 2, launchSlotBuySharePct: 35 });
    expect(f.deployerHoldingPct).toBe(10);
    expect(f.creatorLaunches).toEqual({ priorLaunches: 2, priorGraduated: 0, priorDead: 1, launchesPrior24h: 2 });
    expect(f.unknowns).toEqual(["funding: not read on EVM (no wallet-history index)"]);
  });

  it("finds a deployer's earlier launches through the factory's own event", async () => {
    const factory = addr(0xfac);
    const token = addr(0x70c1);
    const earlier = addr(0x70c0);
    const launchTopic = "0x" + "ab".repeat(32);
    const launchLog = (tok: string, block: number, hash: string): RawLog => ({
      address: factory,
      topics: [launchTopic, topic(DEPLOYER), topic(tok)],
      data: "0x",
      blockNumber: BigInt(block),
      transactionHash: hash,
    });
    const reader = fakeChain({
      transfers: {
        [token.toLowerCase()]: [transfer(6_000_000, 0, "mint", zeroAddress, factory, 1_000n)],
        [earlier.toLowerCase()]: [transfer(5_000_000, 0, "m0", zeroAddress, factory, 1_000n)],
      },
      txs: { mint: { from: DEPLOYER, to: factory, nonce: 7 } },
      contracts: new Set([factory.toLowerCase()]),
      receipts: { mint: [launchLog(token, 6_000_000, "mint")] },
      factoryLogs: [launchLog(earlier, 5_000_000, "m0"), launchLog(token, 6_000_000, "mint")],
    });
    const f = await getEvmLaunchForensics(token, new Date((1_000_000 + 600_100) * 1000), reader);
    expect(f.launchpad).toBe(`factory:${factory.toLowerCase()}`);
    expect(f.creatorLaunches?.priorLaunches).toBe(1);
    // The earlier token went quiet more than 6h before this launch.
    expect(f.creatorLaunches?.priorDead).toBe(1);
  });

  it("leaves deployer launches UNKNOWN when the mint came from a later call to the token", async () => {
    const token = addr(0x7777);
    const reader = fakeChain({
      transfers: { [token.toLowerCase()]: [transfer(6_000_000, 0, "mint", zeroAddress, DEPLOYER, 1_000n)] },
      txs: { mint: { from: DEPLOYER, to: token, nonce: 300 } },
      contracts: new Set(),
    });
    const f = await getEvmLaunchForensics(token, new Date((1_000_000 + 600_100) * 1000), reader);
    expect(f.creatorLaunches).toBeUndefined();
    expect(f.unknowns[0]).toMatch(/^deployer launches: .*later call/);
  });
});
