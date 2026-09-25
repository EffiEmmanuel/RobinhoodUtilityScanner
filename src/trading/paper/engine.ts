import { db } from "../../db";
import { logger } from "../../logger";
import type { Trade } from "../../generated/prisma";
import { resolveTierPure } from "../../backtest/simulate";
import { parsePrimaryPair } from "../../backtest/universe";
import { evaluateExits, stopBaseline } from "../positionManager";
import type { ExitRules } from "../strategy";
import { paperConfig } from "./config";
import { inferDecimals, paperBuyQuote, paperSellQuote } from "./quotes";
import { parseEntry, parseFilter, parseSizing, sizingFraction } from "./strategyConfig";

/**
 * Parallel paper strategies against the live candidate stream. Buys and
 * marks are real Jupiter quotes (quotes.ts); exits run the live
 * evaluateExits on the strategy's StrategyVersion.exitRules, with the same
 * inputs the backtester feeds it, so a paper book is both a strategy trial
 * and a running check on the backtester.
 *
 * Writes only the Paper* tables. Never signs, sends or records execution
 * quality; never touches Trade, LedgerEntry or PortfolioSnapshot.
 */

export interface PositionMeta {
  qualityScore: number | null;
  socialScore: number | null;
  tradeLane: string | null;
  supply?: number; // mcap / price at decision
  liquidityUsdAtDecision?: number;
  pairPriceUsd?: number;
}

export interface PositionState {
  sizeUsd: number;
  costBasisUsd: number;
  realizedProceedsUsd: number;
  tokensRemainingRaw: bigint;
  decimals: number;
  entryPriceUsd: number; // per whole token
  firstMarkPriceUsd: number | null;
  mfePercent: number | null;
  maePercent: number | null;
  openedAt: Date;
  meta: PositionMeta;
}

export interface MarkResult {
  markPriceUsd: number;
  currentMultiple: number;
  firstMarkPriceUsd: number;
  mfePercent: number;
  maePercent: number;
  sell?: { raw: bigint; proceedsUsd: number; closes: boolean; type: string; reason: string };
}

/**
 * One mark of one position. quoteUsd is what selling ALL remaining tokens
 * would return now; a partial sell is priced pro rata from it, which is a
 * little pessimistic (a smaller sell has less impact).
 */
export function evaluatePaperMark(input: {
  state: PositionState;
  quoteUsd: number;
  now: Date;
  exitRules: ExitRules;
  gasSellUsd: number;
  maxHoldHours: number;
}): MarkResult {
  const { state, quoteUsd, now } = input;
  const tokens = Number(state.tokensRemainingRaw) / 10 ** state.decimals;
  const markPriceUsd = tokens > 0 ? quoteUsd / tokens : 0;
  const currentMultiple = state.entryPriceUsd > 0 ? markPriceUsd / state.entryPriceUsd : 1;
  const pnl = (currentMultiple - 1) * 100;
  const firstMarkPriceUsd = state.firstMarkPriceUsd ?? markPriceUsd;
  const mfePercent = Math.max(state.mfePercent ?? pnl, pnl);
  const maePercent = Math.min(state.maePercent ?? pnl, pnl);
  const { meta } = state;
  const entryMcap = meta.supply ? meta.supply * state.entryPriceUsd : undefined;
  const { exitRules } = resolveTierPure(input.exitRules, { qualityScore: meta.qualityScore, entryMcap, socialScore: meta.socialScore });
  const baseline = stopBaseline(state.entryPriceUsd, firstMarkPriceUsd);
  // Same liquidity proxy as the backtester: full-range depth scales with sqrt(price).
  const liquidityUsd =
    meta.liquidityUsdAtDecision && meta.pairPriceUsd ? meta.liquidityUsdAtDecision * Math.sqrt(markPriceUsd / meta.pairPriceUsd) : undefined;
  const trade = {
    id: "paper",
    tradeLane: meta.tradeLane,
    openedAt: state.openedAt,
    entryLiquidityUsd: meta.liquidityUsdAtDecision ?? null,
    mfePercent,
    maePercent,
    actualEntryMcap: entryMcap ?? null,
    entryPriceUsd: state.entryPriceUsd,
    positionSizeUsd: state.sizeUsd,
  } as unknown as Trade;
  const holdingMs = now.getTime() - state.openedAt.getTime();
  // evaluateExits reads the clock itself; shift openedAt so it sees this mark's holding time.
  trade.openedAt = new Date(Date.now() - holdingMs);
  let decision = evaluateExits({
    trade,
    plan: null,
    exitRules,
    currentMcap: meta.supply ? meta.supply * markPriceUsd : undefined,
    currentMultiple,
    unrealizedPnlPercent: pnl,
    liquidityUsd: liquidityUsd ?? 0,
    buySellRatio5m: undefined,
    totalTxns5m: meta.tradeLane === "NARRATIVE_TACTICAL" ? Number.MAX_SAFE_INTEGER : undefined,
    sellQuoteAvailable: true,
    remainingTokens: tokens,
    totalBoughtTokens: state.sizeUsd / state.entryPriceUsd,
    manualHold: false,
    stopPnlPercent: baseline > 0 ? (markPriceUsd / baseline - 1) * 100 : pnl,
    costBasisUsd: state.costBasisUsd,
    realizedProceedsUsd: state.realizedProceedsUsd,
    estimatedSellGasUsd: input.gasSellUsd,
  });
  if (!decision && holdingMs >= input.maxHoldHours * 3_600_000) {
    decision = { type: "TIME_EXIT", sellPercentOfRemaining: 100, reason: `paper hold window of ${input.maxHoldHours}h over`, isEmergency: false };
  }
  const result: MarkResult = { markPriceUsd, currentMultiple, firstMarkPriceUsd, mfePercent, maePercent };
  if (!decision || !(decision.sellPercentOfRemaining > 0)) return result;
  const closes = decision.sellPercentOfRemaining >= 100;
  const raw = closes ? state.tokensRemainingRaw : (state.tokensRemainingRaw * BigInt(Math.round(decision.sellPercentOfRemaining * 100))) / 10_000n;
  if (raw <= 0n) return result;
  const share = Number(raw) / Number(state.tokensRemainingRaw);
  return { ...result, sell: { raw, proceedsUsd: quoteUsd * share, closes: closes || raw >= state.tokensRemainingRaw, type: decision.type, reason: decision.reason } };
}

/**
 * A pump.fun launch keeps its "pump" mint suffix after graduating, so this
 * matches the backtester's launch-venue split (B2/B3).
 */
export function isPumpLaunch(mint: string, dexId: string | undefined): boolean {
  const dex = (dexId ?? "").toLowerCase();
  return mint.endsWith("pump") || dex === "pumpfun" || dex === "pumpswap";
}

type Strategy = Awaited<ReturnType<typeof db.paperStrategy.findMany>>[number];

async function cashUsd(strategy: Strategy): Promise<number> {
  const fills = await db.paperFill.groupBy({ by: ["side"], where: { strategyId: strategy.id }, _sum: { usd: true, gasUsd: true } });
  let cash = strategy.startEquityUsd;
  for (const f of fills) {
    const usd = f._sum.usd ?? 0;
    const gas = f._sum.gasUsd ?? 0;
    cash += f.side === "SELL" ? usd - gas : -(usd + gas);
  }
  return cash;
}

function openValueUsd(positions: { tokensRemainingRaw: string; decimals: number | null; lastMarkPriceUsd: number | null; entryPriceUsd: number | null }[]): number {
  return positions.reduce((sum, p) => {
    const tokens = Number(BigInt(p.tokensRemainingRaw)) / 10 ** (p.decimals ?? 0);
    return sum + tokens * (p.lastMarkPriceUsd ?? p.entryPriceUsd ?? 0);
  }, 0);
}

interface CandidateRow {
  id: string;
  createdAt: Date;
  qualificationPath: string | null;
  tradeLane: string | null;
  qualityScore: number | null;
  chain: string;
  address: string;
  socialScore: number | null;
  pp: unknown;
}

async function intake(strategy: Strategy, now: Date): Promise<void> {
  if (!strategy.candidateCursor) {
    // Starts from activation: never backfills candidates it wasn't around for.
    await db.paperStrategy.update({ where: { id: strategy.id }, data: { candidateCursor: now } });
    return;
  }
  const entry = parseEntry(strategy.entry);
  const sizing = parseSizing(strategy.sizing);
  if ("error" in entry || "error" in sizing) {
    logger.error({ strategy: strategy.name, entry, sizing }, "paper strategy misconfigured — deactivating it");
    await db.paperStrategy.update({ where: { id: strategy.id }, data: { active: false } });
    return;
  }
  const filter = parseFilter(strategy.filter);
  const rows = await db.$queryRaw<CandidateRow[]>`
    select tc.id, tc."createdAt", tc."qualificationPath", tc."tradeLane", tc."qualityScore", t.chain, t.address,
           rr."socialScore", rr."rawResearch"->'market'->'primaryPair' as pp
      from "TradeCandidate" tc
      join "Token" t on t.id = tc."tokenId"
      left join "ResearchRun" rr on rr.id = tc."researchRunId"
     where tc."createdAt" > ${strategy.candidateCursor}
     order by tc."createdAt" asc
     limit 50`;
  let cursor = strategy.candidateCursor;
  for (const c of rows) {
    cursor = c.createdAt;
    if (c.chain !== strategy.chain || c.chain !== "solana" || c.qualificationPath === "MANUAL_BUY_AND_HOLD") continue;
    const pair = parsePrimaryPair(c.pp);
    if (filter.venue && (filter.venue === "pump.fun") !== isPumpLaunch(c.address, pair?.dexId)) continue;
    const open = await db.paperPosition.findMany({ where: { strategyId: strategy.id, status: "OPEN" } });
    if (open.length >= paperConfig.maxOpenPerStrategy) continue;
    const cash = await cashUsd(strategy);
    const equity = cash + openValueUsd(open);
    const sizeUsd = equity * sizingFraction(sizing, equity);
    if (!(sizeUsd > 0) || cash < sizeUsd + paperConfig.gasBuyUsd) continue;
    const quote = await paperBuyQuote(c.address, sizeUsd);
    if ("unavailable" in quote) {
      logger.info({ strategy: strategy.name, candidateId: c.id, reason: quote.unavailable }, "paper entry skipped: no buy quote");
      continue;
    }
    const usdPerRaw = quote.usd / Number(quote.tokensRaw);
    const decimals = inferDecimals(usdPerRaw, pair?.priceUsd, c.address) ?? 0;
    const entryPriceUsd = usdPerRaw * 10 ** decimals;
    const mcap = pair?.marketCapUsd ?? pair?.fdvUsd;
    const meta: PositionMeta = {
      qualityScore: c.qualityScore,
      socialScore: c.socialScore,
      tradeLane: c.tradeLane,
      supply: pair?.priceUsd && mcap ? mcap / pair.priceUsd : undefined,
      liquidityUsdAtDecision: pair?.liquidityUsd,
      pairPriceUsd: pair?.priceUsd,
    };
    await db.$transaction(async (tx) => {
      const position = await tx.paperPosition.create({
        data: {
          strategyId: strategy.id,
          candidateId: c.id,
          chain: c.chain,
          tokenAddress: c.address,
          openedAt: now,
          sizeUsd: quote.usd,
          tokensRaw: quote.tokensRaw.toString(),
          tokensRemainingRaw: quote.tokensRaw.toString(),
          decimals,
          entryPriceUsd,
          costBasisUsd: quote.usd + paperConfig.gasBuyUsd,
          meta: meta as object,
        },
      });
      await tx.paperFill.create({
        data: { positionId: position.id, strategyId: strategy.id, side: "BUY", ts: now, tokensRaw: quote.tokensRaw.toString(), usd: quote.usd, gasUsd: paperConfig.gasBuyUsd, priceUsd: entryPriceUsd, reason: "entry at decision" },
      });
    });
  }
  if (cursor > strategy.candidateCursor) await db.paperStrategy.update({ where: { id: strategy.id }, data: { candidateCursor: cursor } });
}

/**
 * How often a position is marked, to keep inside the daily quote cap: every
 * tick in its first hour (when stops fire most), then every 2 minutes, then
 * every 5 after 6 hours.
 */
export function markDue(openedAt: Date, lastMarkAt: Date | null, now: Date): boolean {
  if (!lastMarkAt) return true;
  const age = now.getTime() - openedAt.getTime();
  const since = now.getTime() - lastMarkAt.getTime();
  if (age < 3_600_000) return true;
  return since >= (age < 6 * 3_600_000 ? 120_000 : 300_000);
}

/**
 * One sell quote per token per tick, shared by every strategy holding it: a
 * smaller holding is priced pro rata from a bigger quote (a little
 * pessimistic, since less size means less impact); a bigger one re-quotes.
 */
export class TickQuoteCache {
  private quotes = new Map<string, { raw: bigint; usd: number }>();

  async sell(mint: string, raw: bigint, quote: typeof paperSellQuote = paperSellQuote): ReturnType<typeof paperSellQuote> {
    const hit = this.quotes.get(mint);
    if (hit && hit.raw >= raw && hit.raw > 0n) return { usd: (hit.usd * Number(raw)) / Number(hit.raw), tokensRaw: raw };
    const q = await quote(mint, raw);
    if (!("unavailable" in q)) this.quotes.set(mint, { raw, usd: q.usd });
    return q;
  }
}

async function manage(strategy: Strategy, exitRules: ExitRules, now: Date, quotes: TickQuoteCache): Promise<void> {
  const open = await db.paperPosition.findMany({ where: { strategyId: strategy.id, status: "OPEN" } });
  for (const p of open) {
    if (!markDue(p.openedAt, p.lastMarkAt, now)) continue;
    const remainingRaw = BigInt(p.tokensRemainingRaw);
    const quote = await quotes.sell(p.tokenAddress, remainingRaw);
    if ("unavailable" in quote) {
      if (quote.unavailable !== "no-route") continue; // budget or SOL price: keep the last mark
      const since = p.quoteFailuresSince ?? now;
      if (now.getTime() - since.getTime() >= paperConfig.writeOffAfterNoQuoteHours * 3_600_000) {
        await closeWithSell(p, strategy.id, now, remainingRaw, 0, 0, "write-off", `no sell route for ${paperConfig.writeOffAfterNoQuoteHours}h`);
      } else if (!p.quoteFailuresSince) {
        await db.paperPosition.update({ where: { id: p.id }, data: { quoteFailuresSince: now } });
      }
      continue;
    }
    const mark = evaluatePaperMark({
      state: {
        sizeUsd: p.sizeUsd,
        costBasisUsd: p.costBasisUsd,
        realizedProceedsUsd: p.realizedProceedsUsd,
        tokensRemainingRaw: remainingRaw,
        decimals: p.decimals ?? 0,
        entryPriceUsd: p.entryPriceUsd ?? 0,
        firstMarkPriceUsd: p.firstMarkPriceUsd,
        mfePercent: p.mfePercent,
        maePercent: p.maePercent,
        openedAt: p.openedAt,
        meta: (p.meta ?? {}) as unknown as PositionMeta,
      },
      quoteUsd: quote.usd,
      now,
      exitRules,
      gasSellUsd: paperConfig.gasSellUsd,
      maxHoldHours: paperConfig.maxHoldHours,
    });
    await db.paperPosition.update({
      where: { id: p.id },
      data: {
        lastMarkPriceUsd: mark.markPriceUsd,
        lastMarkAt: now,
        firstMarkPriceUsd: mark.firstMarkPriceUsd,
        mfePercent: mark.mfePercent,
        maePercent: mark.maePercent,
        quoteFailuresSince: null,
      },
    });
    if (mark.sell) {
      await closeWithSell(p, strategy.id, now, mark.sell.raw, mark.sell.proceedsUsd, paperConfig.gasSellUsd, mark.sell.type, mark.sell.reason, mark.markPriceUsd);
    }
  }
}

async function closeWithSell(
  p: { id: string; tokensRemainingRaw: string; realizedProceedsUsd: number; costBasisUsd: number },
  strategyId: string,
  now: Date,
  raw: bigint,
  proceedsUsd: number,
  gasUsd: number,
  type: string,
  reason: string,
  priceUsd?: number
): Promise<void> {
  const remaining = BigInt(p.tokensRemainingRaw) - raw;
  const realized = p.realizedProceedsUsd + proceedsUsd - gasUsd;
  const closes = remaining <= 0n;
  await db.$transaction([
    db.paperFill.create({ data: { positionId: p.id, strategyId, side: "SELL", ts: now, tokensRaw: raw.toString(), usd: proceedsUsd, gasUsd, priceUsd, reason: `${type}: ${reason}` } }),
    db.paperPosition.update({
      where: { id: p.id },
      data: {
        tokensRemainingRaw: (closes ? 0n : remaining).toString(),
        realizedProceedsUsd: realized,
        ...(closes ? { status: "CLOSED", closedAt: now, exitReason: `${type}: ${reason}`, realizedPnlUsd: realized - p.costBasisUsd } : {}),
      },
    }),
  ]);
}

const lastSnapshotAt = new Map<string, number>();

async function maybeSnapshot(strategy: Strategy, now: Date): Promise<void> {
  const last = lastSnapshotAt.get(strategy.id) ?? 0;
  if (now.getTime() - last < paperConfig.equitySnapshotMinutes * 60_000) return;
  lastSnapshotAt.set(strategy.id, now.getTime());
  const open = await db.paperPosition.findMany({ where: { strategyId: strategy.id, status: "OPEN" } });
  const cash = await cashUsd(strategy);
  const openValue = openValueUsd(open);
  await db.paperEquitySnapshot.create({
    data: { strategyId: strategy.id, capturedAt: now, equityUsd: cash + openValue, cashUsd: cash, openValueUsd: openValue, openPositions: open.length },
  });
}

/** One pass over every active strategy. Each strategy fails alone. */
export async function runPaperTick(now = new Date()): Promise<void> {
  const strategies = await db.paperStrategy.findMany({ where: { active: true } });
  const quotes = new TickQuoteCache();
  for (const strategy of strategies) {
    try {
      const version = await db.strategyVersion.findUnique({ where: { id: strategy.strategyVersionId }, select: { exitRules: true } });
      if (!version) {
        logger.error({ strategy: strategy.name }, "paper strategy's StrategyVersion is missing — skipping it");
        continue;
      }
      const exitRules = version.exitRules as unknown as ExitRules;
      await manage(strategy, exitRules, now, quotes);
      await intake(strategy, now);
      await maybeSnapshot(strategy, now);
    } catch (err) {
      logger.error({ strategy: strategy.name, err: String(err) }, "paper strategy tick failed — other strategies and live trading carry on");
    }
  }
}
