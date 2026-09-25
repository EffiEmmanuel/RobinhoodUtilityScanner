import { encodeEventTopics, getContractAddress, parseAbiItem, zeroAddress, type Hex } from "viem";
import { config } from "../config";
import { computeEarlyBuyerFeatures, type LaunchForensics, type LaunchTokenMove, type LaunchTx } from "./launchForensics";

/**
 * Robinhood Chain (EVM) half of launch forensics (see launchForensics.ts).
 *
 * Built only on logs, receipts and nonces, because neither RPC we have
 * serves historical state (checked 2026-09-25: drpc's free plan answers
 * "Unknown state" and caps eth_getLogs at 10k blocks; the public RPC
 * "historical state ... is not available" and caps a query at 10,000 logs).
 * A Transfer filtered on from = 0x0 is small enough to scan from genesis, so
 * the mint is always findable.
 *
 * - Deployer: whoever sent the mint transaction. Its nonce then is how many
 *   transactions it had sent before, an exact as-of count.
 * - Prior deployments: for a direct deploy, the CREATE addresses of every
 *   earlier nonce; for a factory deploy, the factory's own launch events
 *   that name the deployer.
 * - Dead: a prior token with no Transfer at all in the 6h before the
 *   decision, and launched at least 6h before this one.
 * - Launch block: the first block where a contract (the pool) received the
 *   token, i.e. when liquidity went live. Buys in that block are block-0 buys.
 */

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dead";
// ~100ms blocks on Robinhood Chain.
const SECONDS_PER_BLOCK = 0.1;
const DEAD_WINDOW_SECONDS = 6 * 3600;
const EARLY_WINDOW_BLOCKS = 20_000n;
const EARLY_TRANSFERS_READ = 200;

export interface TransferLog {
  from: string;
  to: string;
  value: bigint;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
}

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  transactionHash: string;
}

/** The handful of reads this needs; `defaultEvmReader` is the real one. */
export interface EvmReader {
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(block: bigint): Promise<number>;
  getTransfers(token: string, filter: { from?: string; to?: string }, fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  getTransaction(hash: string): Promise<{ from: string; to: string | null; nonce: number }>;
  getReceiptLogs(hash: string): Promise<RawLog[]>;
  getLogs(address: string, topics: (string | null)[], fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
  /** True for a deployed contract. EIP-7702 delegated wallets are people, not contracts. */
  isContract(addresses: string[]): Promise<Map<string, boolean>>;
}

export interface EvmForensicsOptions {
  maxPriorNonces: number;
  maxPriorTokensChecked: number;
}

export const DEFAULT_EVM_FORENSICS_OPTIONS: EvmForensicsOptions = { maxPriorNonces: 150, maxPriorTokensChecked: 10 };

const lower = (a: string) => a.toLowerCase();
const topicOf = (addr: string) => "0x" + lower(addr).slice(2).padStart(64, "0");

/** The last block at or before `asOfSeconds`. */
export async function blockAt(reader: EvmReader, asOfSeconds: number): Promise<bigint> {
  const head = await reader.getBlockNumber();
  const headTime = await reader.getBlockTimestamp(head);
  if (asOfSeconds >= headTime) return head;
  let a = { block: head, time: headTime };
  let guess = head - BigInt(Math.round((headTime - asOfSeconds) / SECONDS_PER_BLOCK));
  let b = { block: guess < 0n ? 0n : guess, time: 0 };
  b.time = await reader.getBlockTimestamp(b.block);
  for (let i = 0; i < 8 && Math.abs(b.time - asOfSeconds) > 1; i++) {
    const rate = a.time !== b.time ? Number(a.block - b.block) / (a.time - b.time) : 1 / SECONDS_PER_BLOCK;
    guess = b.block + BigInt(Math.round((asOfSeconds - b.time) * rate));
    a = b;
    b = { block: guess < 0n ? 0n : guess, time: 0 };
    b.time = await reader.getBlockTimestamp(b.block);
  }
  while (b.time > asOfSeconds && b.block > 0n) {
    b.block -= BigInt(Math.max(1, Math.round((b.time - asOfSeconds) / SECONDS_PER_BLOCK)));
    b.time = await reader.getBlockTimestamp(b.block);
  }
  return b.block;
}

/** Group Transfer logs into per-transaction balance changes, in chain order. */
export function transfersToLaunchTxs(logs: TransferLog[], contracts: Map<string, boolean>, feePayers: Map<string, string> = new Map()): LaunchTx[] {
  const sorted = [...logs].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  const byTx = new Map<string, { slot: number; deltas: Map<string, bigint> }>();
  for (const l of sorted) {
    const e = byTx.get(l.transactionHash) ?? { slot: Number(l.blockNumber), deltas: new Map<string, bigint>() };
    const from = lower(l.from);
    const to = lower(l.to);
    e.deltas.set(from, (e.deltas.get(from) ?? 0n) - l.value);
    e.deltas.set(to, (e.deltas.get(to) ?? 0n) + l.value);
    byTx.set(l.transactionHash, e);
  }
  const isProgram = (a: string) => a === zeroAddress || a === DEAD_ADDRESS || contracts.get(a) === true;
  return [...byTx.entries()].map(([hash, e]) => ({
    signature: hash,
    slot: e.slot,
    feePayer: feePayers.get(hash) ?? "",
    moves: [...e.deltas.entries()]
      .filter(([owner, d]) => d !== 0n && owner !== zeroAddress)
      .map(([owner, delta]): LaunchTokenMove => ({ owner, delta, ownerIsProgram: isProgram(owner) })),
  }));
}

/**
 * Launch forensics for one Robinhood Chain token as of `asOf` (defaults to
 * now). Throws only when the mint itself can't be found.
 */
export async function getEvmLaunchForensics(
  token: string,
  asOf: Date | undefined,
  reader: EvmReader = defaultEvmReader(),
  opts: EvmForensicsOptions = DEFAULT_EVM_FORENSICS_OPTIONS
): Promise<LaunchForensics> {
  const unknowns: string[] = [];
  const asOfSeconds = Math.floor((asOf ?? new Date()).getTime() / 1000);
  const asOfBlock = await blockAt(reader, asOfSeconds);
  const result: LaunchForensics = { chain: "robinhood", token: lower(token), asOf: new Date(asOfSeconds * 1000).toISOString(), launchpad: "direct", unknowns };

  const mints = await reader.getTransfers(token, { from: zeroAddress }, 0n, asOfBlock);
  if (mints.length === 0) throw new Error(`no mint of ${token} before block ${asOfBlock}`);
  const mint = mints[0];
  const mintTx = await reader.getTransaction(mint.transactionHash);
  const deployer = lower(mintTx.from);
  const totalSupply = mints.reduce((s, m) => s + m.value, 0n);
  result.creator = deployer;
  result.creatorPriorTxCount = mintTx.nonce;
  result.launchTime = await reader.getBlockTimestamp(mint.blockNumber);
  result.ageAtDecisionSeconds = asOfSeconds - result.launchTime;
  if (mintTx.to && lower(mintTx.to) !== lower(token)) result.launchpad = `factory:${lower(mintTx.to)}`;

  // 1. First buyers, from the mint through the early window.
  try {
    const window = await earlyTransfers(reader, token, mint.blockNumber, asOfBlock);
    // 20 buyers turn up well inside the first 200 transfers; classifying
    // every address in a busy window costs one eth_getCode each.
    const early = window.slice(0, EARLY_TRANSFERS_READ);
    const addresses = [...new Set(early.flatMap((l) => [lower(l.from), lower(l.to)]))].filter((a) => a !== zeroAddress && a !== DEAD_ADDRESS);
    const contracts = await reader.isContract(addresses);
    const txs = transfersToLaunchTxs(early, contracts, new Map([[mint.transactionHash, deployer]]));
    const liveBlock = txs.find((t) => t.moves.some((m) => m.ownerIsProgram && m.delta > 0n))?.slot;
    const features = computeEarlyBuyerFeatures(txs, totalSupply, [], liveBlock);
    if (features) {
      const { firstBuyers: _fb, creator: _c, launchSlot: _s, launchTime: _t, ...rest } = features;
      result.early = rest;
      result.earlyWindowComplete = features.buyersSeen >= 20 || (early.length === window.length && BigInt(txs[txs.length - 1]?.slot ?? 0) >= asOfBlock);
    }
  } catch (err) {
    unknowns.push(`early buyers: ${String(err).slice(0, 120)}`);
  }

  // 2. What the deployer still holds. On EVM the deployer usually mints the
  // whole supply to itself and then seeds the pool, so "sold" can't be told
  // apart from "added liquidity" without the pool's own events; only the
  // current holding is reported.
  try {
    const [outs, ins] = await Promise.all([reader.getTransfers(token, { from: deployer }, mint.blockNumber, asOfBlock), reader.getTransfers(token, { to: deployer }, mint.blockNumber, asOfBlock)]);
    const balance = ins.reduce((s, l) => s + l.value, 0n) - outs.reduce((s, l) => s + l.value, 0n);
    const pct = totalSupply > 0n ? Number(((balance < 0n ? 0n : balance) * 1_000_000n) / totalSupply) / 10_000 : 0;
    result.deployerHoldingPct = pct;
  } catch (err) {
    unknowns.push(`deployer holding: ${String(err).slice(0, 120)}`);
  }

  // 3. The deployer's other tokens, and which of them died.
  try {
    if (mintTx.to !== null && lower(mintTx.to) === lower(token)) throw new Error("the mint came from a later call to the token, so the deploy nonce is unknown");
    const priorTokens =
      mintTx.to === null
        ? await priorDirectDeployments(reader, deployer, mintTx.nonce, token, opts)
        : await priorFactoryDeployments(reader, mint.transactionHash, lower(mintTx.to), deployer, token, mint.blockNumber);
    const checked = priorTokens.slice(-opts.maxPriorTokensChecked);
    const launches = await Promise.all(
      checked.map(async (t) => {
        const first = (await reader.getTransfers(t, { from: zeroAddress }, 0n, asOfBlock))[0];
        if (!first) return undefined;
        const launchTime = await reader.getBlockTimestamp(first.blockNumber);
        const since = asOfBlock - BigInt(Math.round(DEAD_WINDOW_SECONDS / SECONDS_PER_BLOCK));
        const recent = await reader.getTransfers(t, {}, since > 0n ? since : 0n, asOfBlock).catch((err) => {
          // Too many logs to return means it's very much alive.
          if (/exceeds|limit|too many/i.test(String(err))) return [{} as TransferLog];
          throw err;
        });
        return { launchTime, dead: recent.length === 0 };
      })
    );
    const prior = launches.filter((l): l is { launchTime: number; dead: boolean } => Boolean(l) && l!.launchTime < result.launchTime!);
    result.creatorLaunches = {
      priorLaunches: priorTokens.length,
      priorGraduated: 0,
      priorDead: prior.filter((l) => l.dead && result.launchTime! - l.launchTime >= DEAD_WINDOW_SECONDS).length,
      launchesPrior24h: prior.filter((l) => result.launchTime! - l.launchTime <= 86_400).length,
    };
  } catch (err) {
    unknowns.push(`deployer launches: ${String(err).slice(0, 120)}`);
  }
  unknowns.push("funding: not read on EVM (no wallet-history index)");
  return result;
}

/** Transfers from the mint forward, shrinking the window when a query returns too many logs. */
async function earlyTransfers(reader: EvmReader, token: string, fromBlock: bigint, asOfBlock: bigint): Promise<TransferLog[]> {
  let span = EARLY_WINDOW_BLOCKS;
  for (let i = 0; i < 8; i++) {
    const to = fromBlock + span < asOfBlock ? fromBlock + span : asOfBlock;
    try {
      return await reader.getTransfers(token, {}, fromBlock, to);
    } catch (err) {
      if (!/exceeds|limit|too many|range/i.test(String(err))) throw err;
      span /= 4n;
    }
  }
  throw new Error("early transfer window too busy to read");
}

/** Contracts the deployer created at earlier nonces that look like tokens (they minted). */
async function priorDirectDeployments(reader: EvmReader, deployer: string, nonce: number, token: string, opts: EvmForensicsOptions): Promise<string[]> {
  const start = Math.max(0, nonce - opts.maxPriorNonces);
  const candidates = Array.from({ length: nonce - start }, (_, i) => lower(getContractAddress({ from: deployer as Hex, nonce: BigInt(start + i) })));
  const code = await reader.isContract(candidates);
  return candidates.filter((a) => code.get(a) && a !== lower(token));
}

/**
 * Tokens the same deployer launched through the same factory: find the
 * factory event in this launch's receipt that names both the deployer and
 * the token, then ask for every such event naming the deployer.
 */
async function priorFactoryDeployments(reader: EvmReader, mintHash: string, factory: string, deployer: string, token: string, mintBlock: bigint): Promise<string[]> {
  const logs = await reader.getReceiptLogs(mintHash);
  const tokenWord = lower(topicOf(token)).slice(2);
  for (const log of logs.filter((l) => lower(l.address) === factory)) {
    const deployerIdx = log.topics.findIndex((t, i) => i > 0 && lower(t) === topicOf(deployer));
    if (deployerIdx < 0) continue;
    const words = [...log.topics.map((t) => lower(t).slice(2)), ...(log.data.slice(2).match(/.{64}/g) ?? [])];
    const tokenPos = words.findIndex((w) => w === tokenWord);
    if (tokenPos < 0) continue;
    const topics: (string | null)[] = [log.topics[0], null, null, null].slice(0, log.topics.length);
    topics[deployerIdx] = topicOf(deployer);
    const all = await reader.getLogs(factory, topics, 0n, mintBlock);
    return all
      .filter((l) => l.blockNumber < mintBlock || l.transactionHash !== mintHash)
      .map((l) => [...l.topics.map((t) => lower(t).slice(2)), ...(l.data.slice(2).match(/.{64}/g) ?? [])][tokenPos])
      .filter((w): w is string => Boolean(w))
      .map((w) => "0x" + w.slice(24))
      .filter((a) => a !== lower(token));
  }
  return [];
}

export interface JsonRpc {
  call<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
const TRANSFER_TOPIC = encodeEventTopics({ abi: [TRANSFER], eventName: "Transfer" })[0];

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
}

/** EvmReader over plain JSON-RPC, so a replay can put a cache in front of it. */
export function jsonRpcEvmReader(rpc: JsonRpc): EvmReader {
  const blockTimes = new Map<bigint, number>();
  const getLogs = (address: string, topics: (string | null)[], fromBlock: bigint, toBlock: bigint) =>
    rpc.call<RpcLog[]>("eth_getLogs", [{ address, topics, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }]);
  return {
    async getBlockNumber() {
      return BigInt(await rpc.call<string>("eth_blockNumber", []));
    },
    async getBlockTimestamp(block) {
      const cached = blockTimes.get(block);
      if (cached !== undefined) return cached;
      const b = await rpc.call<{ timestamp: string } | null>("eth_getBlockByNumber", [hex(block), false]);
      if (!b) throw new Error(`no block ${block}`);
      const t = Number(BigInt(b.timestamp));
      blockTimes.set(block, t);
      return t;
    },
    async getTransfers(token, filter, fromBlock, toBlock) {
      const logs = await getLogs(token, [TRANSFER_TOPIC, filter.from ? topicOf(filter.from) : null, filter.to ? topicOf(filter.to) : null], fromBlock, toBlock);
      return logs
        .filter((l) => l.topics.length === 3)
        .map((l) => ({
          from: "0x" + l.topics[1].slice(26),
          to: "0x" + l.topics[2].slice(26),
          value: BigInt(l.data === "0x" ? 0 : l.data.slice(0, 66)),
          blockNumber: BigInt(l.blockNumber),
          logIndex: Number(BigInt(l.logIndex)),
          transactionHash: l.transactionHash,
        }));
    },
    async getTransaction(hash) {
      const tx = await rpc.call<{ from: string; to: string | null; nonce: string }>("eth_getTransactionByHash", [hash]);
      return { from: tx.from, to: tx.to ?? null, nonce: Number(BigInt(tx.nonce)) };
    },
    async getReceiptLogs(hash) {
      const r = await rpc.call<{ logs: RpcLog[] }>("eth_getTransactionReceipt", [hash]);
      return r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash }));
    },
    async getLogs(address, topics, fromBlock, toBlock) {
      return (await getLogs(address, topics, fromBlock, toBlock)).map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash }));
    },
    async isContract(addresses) {
      const out = new Map<string, boolean>();
      await Promise.all(
        addresses.map(async (a) => {
          const code = await rpc.call<string>("eth_getCode", [a, "latest"]);
          // EIP-7702 delegation designator: 0xef0100 + address. Still a person's wallet.
          out.set(lower(a), Boolean(code && code !== "0x" && !code.toLowerCase().startsWith("0xef0100")));
        })
      );
      return out;
    },
  };
}

const EVM_RETRYABLE = /429|Too Many|timeout|timed out|ECONNRESET|fetch failed|50\d/i;

/** The configured RH RPC, then its fallback. */
export function defaultEvmReader(): EvmReader {
  const urls = [config.rhRpcUrl, config.rhRpcFallbackUrl].filter(Boolean);
  return jsonRpcEvmReader({
    async call<T>(method: string, params: unknown[]): Promise<T> {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const res = await fetch(urls[attempt % urls.length], {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(20_000),
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 120)}`);
          const body = JSON.parse(text) as { result?: T; error?: { message: string } };
          if (body.error) throw new Error(`${method}: ${body.error.message}`);
          return body.result as T;
        } catch (err) {
          lastErr = err;
          if (!EVM_RETRYABLE.test(String(err))) throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      throw lastErr;
    },
  });
}
