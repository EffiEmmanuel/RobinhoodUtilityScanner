import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { config } from "../config";
import { logger } from "../logger";
import {
  computeCreatorHolding,
  computeEarlyBuyerFeatures,
  computeFundingLinks,
  summarizeCreatorLaunches,
  type LaunchForensics,
  type LaunchRecord,
  type LaunchTokenMove,
  type LaunchTx,
  type WalletFunding,
} from "./launchForensics";

/**
 * Solana half of launch forensics (see launchForensics.ts for the why).
 *
 * Everything is read as of a moment (`asOf`), so the same code runs live
 * (asOf = now) and in replays of past candidates without lookahead:
 * getSignaturesForAddress accepts any transaction signature as `before`, even
 * one that never touched the address, so a signature from the block at
 * `asOf` bounds every history read.
 *
 * Pump.fun launches (most of what we see) read the bonding curve's history,
 * which starts at creation and stops at migration, so the launch is a few
 * pages back even for a busy token. Anything else reads the mint's own
 * history, capped; past the cap the early-buyer features are UNKNOWN.
 *
 * Found live 2026-09-25: Solana now carries version-1 transactions, and
 * getTransaction refuses them unless maxSupportedTransactionVersion is 1.
 */

export interface SolanaRpc {
  call<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

const PUMP_FUN_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const SIGNATURE_PAGE = 1000;
// Pump.fun bonding curve layout: 8-byte discriminator, five u64 reserves
// fields, `complete` (bool) at 48, `creator` (pubkey) at 49..81.
const CURVE_COMPLETE_OFFSET = 48;
const CURVE_CREATOR_OFFSET = 49;
const CURVE_PREFIX_BYTES = 81;
// QuickNode's cheapest tier 413s getMultipleAccounts above 5 keys (see
// solanaHolderConcentration.ts).
const MULTIPLE_ACCOUNTS_BATCH = 5;

export interface SolanaForensicsOptions {
  /** History pages (1000 signatures each) to walk back looking for the launch. */
  maxHistoryPages: number;
  /** Earliest transactions to read looking for 20 distinct buyers. */
  maxEarlyTxs: number;
  maxCreatorTokenTxs: number;
  includeCreatorLaunches: boolean;
  maxCreatorLaunchesDated: number;
  includeFunding: boolean;
  concurrency: number;
}

export const DEFAULT_SOLANA_FORENSICS_OPTIONS: SolanaForensicsOptions = {
  maxHistoryPages: 10,
  maxEarlyTxs: 80,
  maxCreatorTokenTxs: 60,
  includeCreatorLaunches: true,
  maxCreatorLaunchesDated: 25,
  includeFunding: true,
  concurrency: 4,
};

interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

interface ParsedTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

interface ParsedInstruction {
  program?: string;
  programId?: string;
  parsed?: { type?: string; info?: Record<string, unknown> };
}

export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  transaction: { signatures: string[]; message: { accountKeys: { pubkey: string }[]; instructions: ParsedInstruction[] } };
  meta: {
    err: unknown;
    preTokenBalances?: ParsedTokenBalance[];
    postTokenBalances?: ParsedTokenBalance[];
    innerInstructions?: { instructions: ParsedInstruction[] }[];
  } | null;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

const onCurveCache = new Map<string, boolean>();
/** Program-derived addresses (pools, curves, vault authorities) are off the ed25519 curve; people's wallets are on it. */
export function isProgramOwned(owner: string): boolean {
  let cached = onCurveCache.get(owner);
  if (cached === undefined) {
    try {
      cached = !PublicKey.isOnCurve(new PublicKey(owner).toBytes());
    } catch {
      cached = false;
    }
    if (onCurveCache.size > 50_000) onCurveCache.clear();
    onCurveCache.set(owner, cached);
  }
  return cached;
}

/** One transaction's balance changes for one mint, per owning wallet. */
export function toLaunchTx(tx: ParsedTransaction, mint: string): LaunchTx {
  const keys = tx.transaction.message.accountKeys;
  const pre = (tx.meta?.preTokenBalances ?? []).filter((b) => b.mint === mint);
  const post = (tx.meta?.postTokenBalances ?? []).filter((b) => b.mint === mint);
  const byAccount = new Map<number, { owner?: string; pre: bigint; post: bigint }>();
  for (const b of pre) byAccount.set(b.accountIndex, { owner: b.owner, pre: BigInt(b.uiTokenAmount.amount), post: 0n });
  for (const b of post) {
    const e = byAccount.get(b.accountIndex) ?? { owner: b.owner, pre: 0n, post: 0n };
    e.owner = e.owner ?? b.owner;
    e.post = BigInt(b.uiTokenAmount.amount);
    byAccount.set(b.accountIndex, e);
  }
  const byOwner = new Map<string, { delta: bigint; post: bigint }>();
  for (const e of byAccount.values()) {
    if (!e.owner) continue;
    const o = byOwner.get(e.owner) ?? { delta: 0n, post: 0n };
    o.delta += e.post - e.pre;
    o.post += e.post;
    byOwner.set(e.owner, o);
  }
  const moves: LaunchTokenMove[] = [...byOwner.entries()]
    .filter(([, o]) => o.delta !== 0n)
    .map(([owner, o]) => ({ owner, delta: o.delta, post: o.post, ownerIsProgram: isProgramOwned(owner) }));
  return { signature: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime ?? undefined, feePayer: keys[0]?.pubkey ?? "", moves };
}

/** Who sent `wallet` its first SOL, from the wallet's first transaction. */
export function findFunder(tx: ParsedTransaction, wallet: string): string | undefined {
  const all = [...tx.transaction.message.instructions, ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)];
  for (const ix of all) {
    if (ix.program !== "system" || !ix.parsed?.info) continue;
    const info = ix.parsed.info;
    const to = (info.destination ?? info.newAccount) as string | undefined;
    const from = (info.source ?? info.fundingAccount) as string | undefined;
    if (to === wallet && from && from !== wallet) return from;
  }
  const payer = tx.transaction.message.accountKeys[0]?.pubkey;
  return payer && payer !== wallet ? payer : undefined;
}

export interface SolanaAnchor {
  signature: string;
  slot: number;
  blockTime: number;
}

/**
 * The last transaction in the last block at or before `asOfSeconds`, used as
 * `before` on every history read. Secant search on slot → block time, since
 * slot time drifts from the nominal 400ms.
 */
export async function findAnchorAt(rpc: SolanaRpc, asOfSeconds: number): Promise<SolanaAnchor> {
  const blockTime = async (slot: number): Promise<{ slot: number; time: number }> => {
    for (let s = slot, tries = 0; tries < 20; s--, tries++) {
      try {
        const t = await rpc.call<number | null>("getBlockTime", [s]);
        if (t !== null) return { slot: s, time: t };
      } catch {
        // skipped slot: step back
      }
    }
    throw new Error(`no block time near slot ${slot}`);
  };
  const head = await blockTime(await rpc.call<number>("getSlot", [{ commitment: "finalized" }]));
  let a = head;
  let b = await blockTime(Math.max(1, Math.round(head.slot - (head.time - asOfSeconds) / 0.4)));
  for (let i = 0; i < 8 && Math.abs(b.time - asOfSeconds) > 1; i++) {
    const rate = a.time !== b.time ? (a.slot - b.slot) / (a.time - b.time) : 2.5;
    const nextSlot = Math.max(1, Math.round(b.slot + (asOfSeconds - b.time) * rate));
    a = b;
    b = await blockTime(nextSlot);
  }
  // Never read past asOf: step back until the block is at or before it.
  while (b.time > asOfSeconds) b = await blockTime(b.slot - Math.max(1, Math.round((b.time - asOfSeconds) * 2.5)));
  for (let s = b.slot, tries = 0; tries < 20; s--, tries++) {
    try {
      const block = await rpc.call<{ signatures: string[]; blockTime: number } | null>("getBlock", [
        s,
        { transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1 },
      ]);
      if (block && block.signatures.length > 0) return { signature: block.signatures[block.signatures.length - 1], slot: s, blockTime: block.blockTime };
    } catch {
      // skipped or pruned slot
    }
  }
  throw new Error(`no block with transactions near slot ${b.slot}`);
}

async function signaturesBefore(rpc: SolanaRpc, address: string, before: string | undefined, maxPages: number): Promise<{ sigs: SignatureInfo[]; complete: boolean }> {
  const sigs: SignatureInfo[] = [];
  let cursor = before;
  for (let page = 0; page < maxPages; page++) {
    const batch = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [address, { limit: SIGNATURE_PAGE, ...(cursor ? { before: cursor } : {}) }]);
    sigs.push(...batch);
    if (batch.length < SIGNATURE_PAGE) return { sigs, complete: true };
    cursor = batch[batch.length - 1].signature;
  }
  return { sigs, complete: false };
}

async function getTx(rpc: SolanaRpc, signature: string): Promise<ParsedTransaction | undefined> {
  const tx = await rpc.call<ParsedTransaction | null>("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
  return tx ?? undefined;
}

interface CurveInfo {
  creator: string;
  complete: boolean;
}

function pumpCurveAddress(mint: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], PUMP_FUN_PROGRAM)[0].toBase58();
}

function decodeCurve(account: { owner: string; data: [string, string] } | null): CurveInfo | undefined {
  if (!account || account.owner !== PUMP_FUN_PROGRAM.toBase58()) return undefined;
  const data = Buffer.from(account.data[0], "base64");
  if (data.length < CURVE_PREFIX_BYTES) return undefined;
  return { complete: data[CURVE_COMPLETE_OFFSET] === 1, creator: new PublicKey(data.subarray(CURVE_CREATOR_OFFSET, CURVE_PREFIX_BYTES)).toBase58() };
}

const CURVE_SLICE = { encoding: "base64", dataSlice: { offset: 0, length: CURVE_PREFIX_BYTES } };

async function readCurves(rpc: SolanaRpc, mints: string[], concurrency: number): Promise<Map<string, CurveInfo>> {
  const out = new Map<string, CurveInfo>();
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += MULTIPLE_ACCOUNTS_BATCH) chunks.push(mints.slice(i, i + MULTIPLE_ACCOUNTS_BATCH));
  await mapWithConcurrency(chunks, concurrency, async (chunk) => {
    const res = await rpc.call<{ value: ({ owner: string; data: [string, string] } | null)[] }>("getMultipleAccounts", [chunk.map(pumpCurveAddress), CURVE_SLICE]);
    chunk.forEach((mint, i) => {
      const curve = decodeCurve(res.value[i]);
      if (curve) out.set(mint, curve);
    });
  });
  return out;
}

async function walletFunding(rpc: SolanaRpc, wallet: string, before: string): Promise<WalletFunding> {
  const page = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [wallet, { limit: SIGNATURE_PAGE, before }]);
  if (page.length >= SIGNATURE_PAGE || page.length === 0) return { wallet };
  const first = page[page.length - 1];
  const tx = await getTx(rpc, first.signature);
  return { wallet, funder: tx ? findFunder(tx, wallet) : undefined, firstTxTime: first.blockTime ?? undefined };
}

/** Funders with a full page of history before the launch: exchanges, bridges, services. Linking through them proves nothing. */
async function isBusyWallet(rpc: SolanaRpc, wallet: string, before: string): Promise<boolean> {
  const page = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [wallet, { limit: SIGNATURE_PAGE, before }]);
  return page.length >= SIGNATURE_PAGE;
}

/**
 * Launch forensics for one Solana mint as of `asOf` (defaults to now).
 * Throws only when nothing at all could be read; partial reads land in
 * `unknowns`.
 */
export async function getSolanaLaunchForensics(
  mint: string,
  asOf: Date | undefined,
  rpc: SolanaRpc = defaultSolanaRpc(),
  opts: SolanaForensicsOptions = DEFAULT_SOLANA_FORENSICS_OPTIONS
): Promise<LaunchForensics> {
  const unknowns: string[] = [];
  const asOfSeconds = Math.floor((asOf ?? new Date()).getTime() / 1000);
  const anchor = asOf ? (await findAnchorAt(rpc, asOfSeconds)).signature : undefined;

  const [mintInfo, supply, curveRes] = await Promise.all([
    rpc.call<{ value: { owner: string } | null }>("getAccountInfo", [mint, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]),
    rpc.call<{ value: { amount: string } }>("getTokenSupply", [mint]),
    rpc.call<{ value: { owner: string; data: [string, string] } | null }>("getAccountInfo", [pumpCurveAddress(mint), CURVE_SLICE]),
  ]);
  const totalSupply = BigInt(supply.value.amount);
  const tokenProgram = mintInfo.value?.owner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const curve = decodeCurve(curveRes.value);
  const result: LaunchForensics = { chain: "solana", token: mint, asOf: new Date(asOfSeconds * 1000).toISOString(), launchpad: curve ? "pumpfun" : "other", unknowns };

  // 1. The launch and the first buyers.
  const historyAddress = curve ? pumpCurveAddress(mint) : mint;
  const history = await signaturesBefore(rpc, historyAddress, anchor, opts.maxHistoryPages);
  const ok = history.sigs.filter((s) => s.err === null).reverse();
  if (!history.complete) {
    unknowns.push(`early buyers: launch is more than ${opts.maxHistoryPages * SIGNATURE_PAGE} transactions back`);
  } else if (ok.length === 0) {
    unknowns.push("early buyers: no successful transactions before the decision");
  } else {
    const early: LaunchTx[] = [];
    const insiderHint = curve ? [curve.creator] : [];
    let buyers = 0;
    let i = 0;
    while (i < ok.length && i < opts.maxEarlyTxs && buyers < 20) {
      const slice = ok.slice(i, Math.min(i + 10, opts.maxEarlyTxs));
      i += slice.length;
      const txs = await mapWithConcurrency(slice, opts.concurrency, (s) => getTx(rpc, s.signature));
      for (const tx of txs) if (tx) early.push(toLaunchTx(tx, mint));
      buyers = computeEarlyBuyerFeatures(early, totalSupply, insiderHint)?.buyersSeen ?? 0;
    }
    const features = early[0]?.signature === ok[0].signature ? computeEarlyBuyerFeatures(early, totalSupply, insiderHint) : undefined;
    if (!features) unknowns.push("early buyers: couldn't read the launch transaction");
    if (features) {
      const { firstBuyers, creator, launchSlot: _slot, launchTime, ...rest } = features;
      const insiders = [...new Set([creator, ...insiderHint])];
      result.creator = creator;
      if (curve && curve.creator !== creator) result.curveCreator = curve.creator;
      result.launchTime = launchTime;
      result.ageAtDecisionSeconds = launchTime !== undefined ? asOfSeconds - launchTime : undefined;
      result.early = rest;
      result.earlyWindowComplete = features.buyersSeen >= 20 || i >= ok.length;
      const launch = early[0];
      const launchSig = launch.signature;

      // 2. What the creator did with its own tokens. Track whichever insider
      // took the dev buy. Sniper bots reference a fresh creator's token
      // account read-only in thousands of failed transactions (881 of the
      // first 1,000 on x-0), so this reads several pages.
      try {
        const devBuy = launch.moves.filter((m) => insiders.includes(m.owner) && m.delta > 0n).sort((a, b) => (b.delta > a.delta ? 1 : -1))[0];
        const holder = devBuy?.owner ?? creator;
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(holder), true, tokenProgram).toBase58();
        const ataHistory = await signaturesBefore(rpc, ata, anchor, 5);
        const ataSigs = ataHistory.sigs.filter((s) => s.err === null && s.signature !== launchSig).reverse();
        const picked = ataSigs.length > opts.maxCreatorTokenTxs ? [...ataSigs.slice(0, 20), ...ataSigs.slice(-(opts.maxCreatorTokenTxs - 20))] : ataSigs;
        const txs = await mapWithConcurrency(picked, opts.concurrency, (s) => getTx(rpc, s.signature));
        const holderTxs = [launch, ...txs.filter((t): t is ParsedTransaction => Boolean(t)).map((t) => toLaunchTx(t, mint))];
        result.creatorHolding = computeCreatorHolding(holderTxs, holder, totalSupply);
        result.creatorHoldingComplete = ataHistory.complete && picked.length === ataSigs.length;
      } catch (err) {
        unknowns.push(`creator holding: ${String(err).slice(0, 120)}`);
      }

      // 3. The creator's past: prior transactions, wallet age, other launches.
      try {
        const prior = await rpc.call<SignatureInfo[]>("getSignaturesForAddress", [creator, { limit: SIGNATURE_PAGE, before: launchSig }]);
        result.creatorPriorTxCount = prior.length;
        if (prior.length < SIGNATURE_PAGE && prior.length > 0 && launchTime !== undefined) {
          const oldest = prior[prior.length - 1].blockTime;
          if (oldest) result.creatorWalletAgeHoursAtLaunch = (launchTime - oldest) / 3600;
        }
      } catch (err) {
        unknowns.push(`creator history: ${String(err).slice(0, 120)}`);
      }
      if (opts.includeCreatorLaunches && curve && launchTime !== undefined) {
        try {
          result.creatorLaunches = summarizeCreatorLaunches(await creatorPumpLaunches(rpc, insiders, mint, opts), launchTime);
        } catch (err) {
          unknowns.push(`creator launches: ${String(err).slice(0, 120)}`);
        }
      } else if (opts.includeCreatorLaunches) {
        unknowns.push("creator launches: only read for pump.fun launches");
      }

      // 4. Who funded the creator and the first buyers.
      if (opts.includeFunding) {
        try {
          const creatorFunding = await walletFunding(rpc, creator, launchSig);
          const fundings = await mapWithConcurrency(firstBuyers, opts.concurrency, (b) => walletFunding(rpc, b.wallet, b.signature));
          const byWallet = new Map(fundings.map((f) => [f.wallet, f]));
          const funders = [...new Set([creatorFunding.funder, ...fundings.map((f) => f.funder)].filter((f): f is string => Boolean(f)))];
          const busy = new Set<string>();
          await mapWithConcurrency(funders, opts.concurrency, async (f) => {
            if (!insiders.includes(f) && (await isBusyWallet(rpc, f, launchSig))) busy.add(f);
          });
          result.funding = computeFundingLinks(firstBuyers, insiders, creatorFunding, byWallet, busy, totalSupply);
        } catch (err) {
          unknowns.push(`funding: ${String(err).slice(0, 120)}`);
        }
      }
    }
  }
  return result;
}

/**
 * Other pump.fun launches by the same creator, dated. Found through the
 * creator's token accounts (a dev buy leaves one open), so a launch without a
 * dev buy, or whose account was closed, is missed: a lower bound.
 *
 * A launch is dated by the oldest transaction on the creator's token account
 * for it. When bot traffic hides the true oldest, the oldest one seen is
 * still an upper bound on the launch time, which is the safe direction: a
 * launch can only look more recent than it was, never earlier.
 */
async function creatorPumpLaunches(rpc: SolanaRpc, insiders: string[], mint: string, opts: SolanaForensicsOptions): Promise<LaunchRecord[]> {
  type TokenAccounts = { value: { pubkey: string; account: { data: { parsed: { info: { mint: string } } } } }[] };
  const lists = await Promise.all(
    insiders.flatMap((owner) =>
      [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map((p) => rpc.call<TokenAccounts>("getTokenAccountsByOwner", [owner, { programId: p.toBase58() }, { encoding: "jsonParsed" }]))
    )
  );
  const seen = new Set<string>();
  const accounts = lists
    .flatMap((l) => l.value)
    .map((a) => ({ account: a.pubkey, mint: a.account.data.parsed.info.mint }))
    .filter((a) => a.mint !== mint && !seen.has(a.mint) && seen.add(a.mint))
    .slice(0, 100);
  const curves = await readCurves(rpc, accounts.map((a) => a.mint), opts.concurrency);
  const mine = accounts.filter((a) => insiders.includes(curves.get(a.mint)?.creator ?? "")).slice(0, opts.maxCreatorLaunchesDated);
  const dated = await mapWithConcurrency(mine, opts.concurrency, async (a) => {
    const { sigs } = await signaturesBefore(rpc, a.account, undefined, 3);
    const oldest = sigs[sigs.length - 1]?.blockTime;
    return oldest ? { launchTime: oldest, graduated: curves.get(a.mint)!.complete } : undefined;
  });
  return dated.filter((d): d is LaunchRecord => Boolean(d));
}

const RETRYABLE = /429|Too many|unhealthy|timeout|timed out|ECONNRESET|fetch failed|503|502|504/i;

/** Plain JSON-RPC over every configured Solana endpoint, with backoff on rate limits. */
export function defaultSolanaRpc(): SolanaRpc {
  const urls = [config.solanaRpcUrl, ...config.solanaRpcExtraUrls, config.solanaRpcFallbackUrl].filter((u): u is string => Boolean(u));
  if (urls.length === 0) throw new Error("SOLANA_RPC_URL is not set — cannot read launch forensics");
  return {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        const url = urls[attempt % urls.length];
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(20_000),
          });
          const text = await res.text();
          if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 120)}`);
          const body = JSON.parse(text) as { result?: T; error?: { code: number; message: string } };
          if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`);
          return body.result as T;
        } catch (err) {
          lastErr = err;
          if (!RETRYABLE.test(String(err))) throw err;
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      logger.warn({ method, err: String(lastErr) }, "launch forensics RPC call failed after retries");
      throw lastErr;
    },
  };
}
