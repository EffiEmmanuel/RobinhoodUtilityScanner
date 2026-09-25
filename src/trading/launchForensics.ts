/**
 * Launch forensics: who bought a token first, and what its creator did.
 *
 * Study 2026-09-25 (Worker C, C1): 46 of 66 autonomous buys fell below 0.3x
 * of entry within 24h. Rugs move faster than any price poller, so the check
 * has to happen before the buy. Published work on memecoin launches
 * (arXiv 2602.13480) found two strong tells: bundled wallets, and how much
 * supply the first 10-20 buyers took.
 *
 * This file is the chain-agnostic half: the feature math over a launch's
 * earliest transactions, and the gate verdict. solanaLaunchForensics.ts and
 * evmLaunchForensics.ts gather the transactions.
 *
 * Standing user rules this follows:
 *  - Only positive evidence of manipulation counts. A feature that couldn't
 *    be read is UNKNOWN and never blocks.
 *  - Never penalize newness or an anonymous team. A fresh creator wallet is
 *    recorded for study but is not a gate check.
 */

/** One wallet's change in the token's balance within one transaction. */
export interface LaunchTokenMove {
  owner: string;
  delta: bigint;
  /** Balance after the transaction, when the source reports it. */
  post?: bigint;
  /** Pool vaults, bonding curves and other program-owned accounts. Never a buyer. */
  ownerIsProgram: boolean;
}

export interface LaunchTx {
  signature: string;
  /** Slot on Solana, block number on EVM chains. */
  slot: number;
  blockTime?: number;
  /** Who signed and paid: the creator for the launch tx, the buyer for a buy. */
  feePayer: string;
  moves: LaunchTokenMove[];
}

export interface EarlyBuyerFeatures {
  creator: string;
  launchSlot: number;
  launchTime?: number;
  /** Supply the creator took in the launch transaction itself (dev buy). */
  creatorInitialBuyPct: number;
  /** Distinct non-creator wallets that received tokens in the examined window. */
  buyersSeen: number;
  first10BuyerSharePct: number;
  first20BuyerSharePct: number;
  /** Distinct non-creator buyers in the launch slot/block itself (block-0 buys). */
  launchSlotBuyerCount: number;
  launchSlotBuySharePct: number;
  /** First-20 buyers who landed in the same slot as another first-20 buyer or the creator. */
  sameSlotBuyerCount: number;
  sameSlotBuySharePct: number;
  /** The first-20 buyers, in order, for the funding-link check. */
  firstBuyers: { wallet: string; slot: number; signature: string; acquired: bigint }[];
}

const FIRST_BUYERS = 20;

function pct(raw: bigint, totalSupply: bigint): number {
  if (totalSupply <= 0n) return 0;
  return Number((raw * 1_000_000n) / totalSupply) / 10_000;
}

/**
 * Feature math over a launch's earliest transactions, oldest first. The
 * first transaction must be the launch (creation) itself, and whoever paid
 * for it is the creator. `otherInsiders` count as the creator too: on
 * pump.fun the curve's recorded creator is often a different wallet from the
 * one that deployed and made the dev buy (2 of 3 launches checked
 * 2026-09-25). "Bought" means any positive balance change for a wallet,
 * including tokens handed out by the creator: an insider distribution is the
 * same risk as an insider buy.
 */
export function computeEarlyBuyerFeatures(txs: LaunchTx[], totalSupply: bigint, otherInsiders: string[] = [], launchSlotOverride?: number): EarlyBuyerFeatures | undefined {
  if (txs.length === 0 || totalSupply <= 0n) return undefined;
  const launch = { ...txs[0], slot: launchSlotOverride ?? txs[0].slot };
  const creator = launch.feePayer;
  const insiders = new Set([creator, ...otherInsiders]);

  const creatorInitial = launch.moves.filter((m) => insiders.has(m.owner) && m.delta > 0n).reduce((s, m) => s + m.delta, 0n);

  const order: string[] = [];
  const acquired = new Map<string, bigint>();
  const firstSeen = new Map<string, { slot: number; signature: string }>();
  for (const tx of txs) {
    for (const m of tx.moves) {
      if (m.ownerIsProgram || insiders.has(m.owner) || m.delta <= 0n) continue;
      if (!acquired.has(m.owner)) {
        order.push(m.owner);
        firstSeen.set(m.owner, { slot: tx.slot, signature: tx.signature });
        acquired.set(m.owner, 0n);
      }
      acquired.set(m.owner, (acquired.get(m.owner) ?? 0n) + m.delta);
    }
  }

  const firstN = (n: number) => order.slice(0, n).reduce((s, w) => s + (acquired.get(w) ?? 0n), 0n);

  const launchSlotBuyers = order.filter((w) => firstSeen.get(w)?.slot === launch.slot);
  const first20 = order.slice(0, FIRST_BUYERS);
  const slotCounts = new Map<number, number>();
  for (const w of first20) {
    const slot = firstSeen.get(w)!.slot;
    slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1);
  }
  // The creator's launch counts as an occupant of the launch slot, so a
  // single wallet buying alongside the creation is still a same-slot buy.
  const occupied = (slot: number) => (slotCounts.get(slot) ?? 0) + (slot === launch.slot ? 1 : 0);
  const sameSlot = first20.filter((w) => occupied(firstSeen.get(w)!.slot) >= 2);

  return {
    creator,
    launchSlot: launch.slot,
    launchTime: launch.blockTime,
    creatorInitialBuyPct: pct(creatorInitial, totalSupply),
    buyersSeen: order.length,
    first10BuyerSharePct: pct(firstN(10), totalSupply),
    first20BuyerSharePct: pct(firstN(FIRST_BUYERS), totalSupply),
    launchSlotBuyerCount: launchSlotBuyers.length,
    launchSlotBuySharePct: pct(launchSlotBuyers.reduce((s, w) => s + (acquired.get(w) ?? 0n), 0n), totalSupply),
    sameSlotBuyerCount: sameSlot.length,
    sameSlotBuySharePct: pct(sameSlot.reduce((s, w) => s + (acquired.get(w) ?? 0n), 0n), totalSupply),
    firstBuyers: first20.map((w) => ({ wallet: w, slot: firstSeen.get(w)!.slot, signature: firstSeen.get(w)!.signature, acquired: acquired.get(w) ?? 0n })),
  };
}

export interface CreatorHoldingFeatures {
  peakPct: number;
  currentPct: number;
  /** Share of the creator's peak holding gone (sold or sent away) by now. 0 when it never held any. */
  soldPctOfPeak: number;
  sellTxCount: number;
}

/**
 * Creator balance over time, from the transactions that touched the
 * creator's token account up to the decision time, oldest first. Balances
 * after each transaction are absolute, so a window that misses some older
 * transactions still gets the current holding right; the peak is then a
 * lower bound.
 */
export function computeCreatorHolding(txs: LaunchTx[], creator: string, totalSupply: bigint): CreatorHoldingFeatures {
  let balance = 0n;
  let peak = 0n;
  let sells = 0;
  for (const tx of txs) {
    const mine = tx.moves.filter((m) => m.owner === creator);
    if (mine.length === 0) continue;
    const delta = mine.reduce((s, m) => s + m.delta, 0n);
    const posts = mine.map((m) => m.post).filter((p): p is bigint => p !== undefined);
    balance = posts.length === mine.length ? posts.reduce((s, p) => s + p, 0n) : balance + delta;
    if (balance < 0n) balance = 0n;
    if (balance > peak) peak = balance;
    if (delta < 0n) sells++;
  }
  const soldPctOfPeak = peak > 0n ? Number(((peak - balance) * 10_000n) / peak) / 100 : 0;
  return { peakPct: pct(peak, totalSupply), currentPct: pct(balance, totalSupply), soldPctOfPeak, sellTxCount: sells };
}

export interface CreatorLaunchHistory {
  /** Launches by the same creator dated before this one. A lower bound: launches it left no trace of are missed. */
  priorLaunches: number;
  /** Of those, how many finished their bonding curve / reached a real pool. */
  priorGraduated: number;
  /** Prior launches at least 6h older than this one that never graduated. */
  priorDead: number;
  launchesPrior24h: number;
}

export interface LaunchRecord {
  launchTime: number;
  graduated: boolean;
}

const DEAD_AFTER_SECONDS = 6 * 3600;

export function summarizeCreatorLaunches(launches: LaunchRecord[], thisLaunchTime: number): CreatorLaunchHistory {
  const prior = launches.filter((l) => l.launchTime < thisLaunchTime);
  return {
    priorLaunches: prior.length,
    priorGraduated: prior.filter((l) => l.graduated).length,
    priorDead: prior.filter((l) => !l.graduated && thisLaunchTime - l.launchTime >= DEAD_AFTER_SECONDS).length,
    launchesPrior24h: prior.filter((l) => thisLaunchTime - l.launchTime <= 86_400).length,
  };
}

export interface WalletFunding {
  wallet: string;
  /** Sender of the wallet's first incoming SOL/ETH, when its first transaction was reachable. */
  funder?: string;
  firstTxTime?: number;
}

export interface FundingLinkFeatures {
  /** First-20 buyers funded by the creator or by the creator's own funder. */
  creatorLinkedBuyers: number;
  creatorLinkedSharePct: number;
  /** Largest group of first-20 buyers funded by one wallet (excluding busy wallets like exchanges). */
  largestFunderCluster: number;
  /** Who funded the largest cluster, for audit. */
  largestClusterFunder?: string;
  clusteredBuyerSharePct: number;
  buyersWithKnownFunder: number;
}

/**
 * Wallets that got their money from the creator, or from one shared source,
 * are the "bundled wallets" the research flags. A busy funder (an exchange
 * hot wallet, a bridge) funds thousands of strangers and proves nothing, so
 * callers pass those in `busyFunders` and they never link anyone.
 */
export function computeFundingLinks(
  buyers: EarlyBuyerFeatures["firstBuyers"],
  insiders: string[],
  creatorFunding: WalletFunding | undefined,
  buyerFunding: Map<string, WalletFunding>,
  busyFunders: Set<string>,
  totalSupply: bigint
): FundingLinkFeatures {
  const creatorFunder = creatorFunding?.funder && !busyFunders.has(creatorFunding.funder) ? creatorFunding.funder : undefined;
  const insiderSet = new Set(insiders);
  let linked = 0n;
  let linkedCount = 0;
  const byFunder = new Map<string, { count: number; acquired: bigint }>();
  let known = 0;
  for (const b of buyers) {
    const f = buyerFunding.get(b.wallet)?.funder;
    if (!f) continue;
    known++;
    if (insiderSet.has(f) || (creatorFunder && f === creatorFunder)) {
      linkedCount++;
      linked += b.acquired;
    }
    if (busyFunders.has(f)) continue;
    const g = byFunder.get(f) ?? { count: 0, acquired: 0n };
    g.count++;
    g.acquired += b.acquired;
    byFunder.set(f, g);
  }
  const clusters = [...byFunder.values()].filter((g) => g.count >= 2);
  const largest = [...byFunder.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  return {
    creatorLinkedBuyers: linkedCount,
    creatorLinkedSharePct: pct(linked, totalSupply),
    largestFunderCluster: largest?.[1].count ?? 0,
    ...(largest && largest[1].count >= 2 ? { largestClusterFunder: largest[0] } : {}),
    clusteredBuyerSharePct: pct(clusters.reduce((s, g) => s + g.acquired, 0n), totalSupply),
    buyersWithKnownFunder: known,
  };
}

/** Everything the forensics pass learned about one token as of one moment. */
export interface LaunchForensics {
  chain: string;
  token: string;
  asOf: string;
  launchpad: string;
  /** Who paid for the launch transaction. */
  creator?: string;
  /** The pump.fun curve's recorded creator, when it isn't the deployer. */
  curveCreator?: string;
  launchTime?: number;
  /** Seconds from launch to the decision. */
  ageAtDecisionSeconds?: number;
  early?: Omit<EarlyBuyerFeatures, "firstBuyers" | "creator" | "launchSlot" | "launchTime">;
  /** True when the early window reached 20 buyers or the decision time. */
  earlyWindowComplete?: boolean;
  creatorHolding?: CreatorHoldingFeatures;
  /** False when the creator's token history before the decision was too long to read in full (peak is then a lower bound). */
  creatorHoldingComplete?: boolean;
  /** EVM only: the deployer's share of supply at the decision. Its "sells" can't be told apart from seeding the pool. */
  deployerHoldingPct?: number;
  creatorLaunches?: CreatorLaunchHistory;
  creatorPriorTxCount?: number;
  creatorWalletAgeHoursAtLaunch?: number;
  funding?: FundingLinkFeatures;
  /** Feature groups that couldn't be read, with why. Unknown never blocks. */
  unknowns: string[];
}

export interface LaunchForensicsThresholds {
  /** Block when the first 20 buyers took at least this % of supply. 0 = off. */
  maxFirst20BuyerSharePct: number;
  /** Block when block-0 buyers (same slot as the launch) took at least this % of supply. 0 = off. */
  maxLaunchSlotBuySharePct: number;
  /** Block when the creator has already sold at least this % of its peak holding. 0 = off. */
  maxCreatorSoldPctOfPeak: number;
  /** Block when the creator has at least this many prior launches that died. 0 = off. */
  maxCreatorPriorDeadLaunches: number;
  /** Block when buyers funded by the creator or one shared source hold at least this % of supply. 0 = off. */
  maxLinkedBuyerSharePct: number;
}

export interface LaunchForensicsVerdict {
  passed: boolean;
  failedChecks: string[];
  reasons: string[];
}

/**
 * Only positive evidence blocks. Every check needs its feature to have been
 * read; a missing feature passes.
 */
export function evaluateLaunchForensics(f: LaunchForensics | undefined, t: LaunchForensicsThresholds): LaunchForensicsVerdict {
  const failedChecks: string[] = [];
  const reasons: string[] = [];
  if (!f) return { passed: true, failedChecks, reasons };

  if (t.maxFirst20BuyerSharePct > 0 && f.early && f.early.first20BuyerSharePct >= t.maxFirst20BuyerSharePct) {
    failedChecks.push("firstBuyersShare");
    reasons.push(`first ${Math.min(20, f.early.buyersSeen)} buyers took ${f.early.first20BuyerSharePct.toFixed(1)}% of supply (>= ${t.maxFirst20BuyerSharePct}%)`);
  }
  if (t.maxLaunchSlotBuySharePct > 0 && f.early && f.early.launchSlotBuySharePct >= t.maxLaunchSlotBuySharePct) {
    failedChecks.push("launchBlockBundle");
    reasons.push(`${f.early.launchSlotBuyerCount} wallets bought in the launch block itself, taking ${f.early.launchSlotBuySharePct.toFixed(1)}% of supply (>= ${t.maxLaunchSlotBuySharePct}%)`);
  }
  if (t.maxCreatorSoldPctOfPeak > 0 && f.creatorHolding && f.creatorHolding.peakPct > 0 && f.creatorHolding.soldPctOfPeak >= t.maxCreatorSoldPctOfPeak) {
    failedChecks.push("creatorSelling");
    reasons.push(`creator has already sold ${f.creatorHolding.soldPctOfPeak.toFixed(0)}% of its peak holding (>= ${t.maxCreatorSoldPctOfPeak}%)`);
  }
  if (t.maxCreatorPriorDeadLaunches > 0 && f.creatorLaunches && f.creatorLaunches.priorDead >= t.maxCreatorPriorDeadLaunches) {
    failedChecks.push("serialLauncher");
    reasons.push(`creator launched ${f.creatorLaunches.priorLaunches} tokens before this one and ${f.creatorLaunches.priorDead} died (>= ${t.maxCreatorPriorDeadLaunches})`);
  }
  if (t.maxLinkedBuyerSharePct > 0 && f.funding) {
    const linked = Math.max(f.funding.creatorLinkedSharePct, f.funding.clusteredBuyerSharePct);
    if (linked >= t.maxLinkedBuyerSharePct) {
      failedChecks.push("linkedBuyers");
      reasons.push(`early buyers funded by the creator or one shared wallet took ${linked.toFixed(1)}% of supply (>= ${t.maxLinkedBuyerSharePct}%)`);
    }
  }
  return { passed: failedChecks.length === 0, failedChecks, reasons };
}
