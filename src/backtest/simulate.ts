import type { Trade } from "../generated/prisma";
import { evaluateExits, nextStopBreach, stopBaseline } from "../trading/positionManager";
import type { ExitRules, ProjectTier } from "../trading/strategy";
import { type Candle, candleAt } from "./candles";
import { type ChainCostModel, buyFillPrice, liquidityAt, sellFillPrice } from "./costs";

/**
 * Replays one position bar by bar through the LIVE exit code
 * (positionManager.ts's evaluateExits and stopBaseline), so any
 * StrategyVersion.exitRules JSON runs exactly as production would run it.
 *
 * Intrabar modes:
 *   - "worst" (default): each candle is walked as four ticks, in the order
 *     that is worst for a long position given the bar's direction (up bars
 *     O→L→H→C, down bars O→H→L→C). Every wick counts, so this over-triggers
 *     stops compared with live's ~5s sampler, which misses brief wicks.
 *   - "close": one tick per candle, at the close. This approximates a
 *     sampled monitor that misses wicks altogether, which is optimistic.
 * A tick's mark is what live marks with, a sell quote: price minus exit
 * slippage and impact, over the fee-inclusive entry fill.
 *
 * Fills are pessimistic:
 *   - a sell decided at a low fills at that low;
 *   - one decided at a high fills at the bar's close if that's lower, so a
 *     one-trade wick can't be sold into;
 *   - the entry candle contributes only its close.
 *
 * Not replayed, because OHLCV can't show them:
 *   - the AI strategy review (live's only profit-taker since 2026-09-22);
 *   - DCA re-entries;
 *   - buy/sell-count exits (extreme sell pressure, narrative volume fade);
 *   - honeypots and unsellable tokens: sells always get a quote here.
 */

export interface SimCandidateMeta {
  chain: string;
  qualityScore: number | null;
  socialScore: number | null;
  qualificationPath: string | null;
  tradeLane: string | null;
  invalidationMcap: number | null;
  supply: number | undefined; // mcap / price at decision, for invalidation checks
  liquidityUsdAtDecision: number | undefined;
  midAtDecision: number | undefined;
}

export interface SimLeg {
  ts: number;
  fraction: number; // of the tokens originally bought
  mid: number; // reference price the sell filled against
  liquidityUsd: number | undefined;
  type: string;
  reason: string;
}

export interface SimResult {
  entryTs: number;
  entryMid: number;
  entryFill: number; // at the reference size
  entryLiquidityUsd: number | undefined;
  tier: ProjectTier;
  legs: SimLeg[];
  peakMultiple: number; // best mark / entry fill
  troughMultiple: number;
  exitReason: string;
  holdMinutes: number;
}

export interface SimulateInput {
  candles: Candle[];
  coverageEnd: number;
  entryTs: number;
  meta: SimCandidateMeta;
  exitRules: ExitRules;
  costs: ChainCostModel;
  sizeUsd: number; // reference size used for decisions (impact on the marks)
  holdWindowS?: number;
  legacyProfitSteps?: boolean; // pre-2026-09-22 PROFIT_TARGET ladder, for as-was replays
  intrabar?: IntrabarMode;
  entryFillOverride?: number; // calibration: the real fill price
}

export interface RefPrice {
  price: number;
  ts: number; // when that price was current
  nextIdx: number; // first candle strictly after it
}

/**
 * The price at ts: the close of the candle containing ts (our own swap
 * lands in that interval), else the last close before ts, which is still
 * the pool price because nothing traded since.
 */
export function refPrice(candles: Candle[], ts: number): RefPrice | undefined {
  const idx = candleAt(candles, ts);
  if (idx < 0) return undefined;
  const c = candles[idx];
  if (ts < c.t + c.d) return { price: c.c, ts: c.t + c.d, nextIdx: idx + 1 };
  return { price: c.c, ts, nextIdx: idx + 1 };
}

/** positionManager.ts's resolveTier, minus the DB reads (inputs passed in). */
export function resolveTierPure(
  base: ExitRules,
  input: { qualityScore: number | null; entryMcap: number | undefined; socialScore: number | null }
): { exitRules: ExitRules; tier: ProjectTier } {
  const { fastFlip, goodProject } = base;
  const q = input.qualityScore ?? undefined;
  if (fastFlip) {
    const isLowQuality = q !== undefined && q < fastFlip.qualityScoreThreshold;
    const isLargeEntryNotYetProven =
      input.entryMcap !== undefined && input.entryMcap > fastFlip.largeMcapUsd && (q === undefined || q < fastFlip.veryGoodQualityScoreThreshold);
    if (isLowQuality || isLargeEntryNotYetProven) {
      // v1.9 drops fastFlip's own ladder and trail; absent overrides fall
      // back to the base profile, as live resolveTier does.
      const ff = fastFlip as Partial<NonNullable<ExitRules["fastFlip"]>>;
      return {
        tier: "FAST_FLIP",
        exitRules: {
          ...base,
          profitSteps: ff.profitSteps ?? base.profitSteps,
          trailingActivationMultiple: ff.trailingActivationMultiple ?? base.trailingActivationMultiple,
          trailingPercent: ff.trailingPercent ?? base.trailingPercent,
          maxHoldMinutes: ff.maxHoldMinutes ?? base.maxHoldMinutes,
        },
      };
    }
  }
  if (goodProject && input.socialScore != null && input.socialScore >= goodProject.minSocialScoreToQualify) {
    return { tier: "GOOD_PROJECT", exitRules: { ...base, maxHoldMinutes: goodProject.maxHoldMinutes } };
  }
  return { tier: "BASE", exitRules: base };
}

interface Tick {
  ts: number;
  price: number;
  atHigh: boolean;
  barClose: number;
}

export type IntrabarMode = "worst" | "close";

function ticksOf(c: Candle, mode: IntrabarMode): Tick[] {
  if (mode === "close") return [{ ts: c.t + c.d, price: c.c, atHigh: false, barClose: c.c }];
  const up = c.c >= c.o;
  const [a, b] = up ? [c.l, c.h] : [c.h, c.l];
  return [
    { ts: c.t, price: c.o, atHigh: false, barClose: c.c },
    { ts: c.t + c.d / 3, price: a, atHigh: !up, barClose: c.c },
    { ts: c.t + (2 * c.d) / 3, price: b, atHigh: up, barClose: c.c },
    { ts: c.t + c.d, price: c.c, atHigh: false, barClose: c.c },
  ];
}

export const DEFAULT_HOLD_WINDOW_S = 48 * 3_600;
const MANUAL_BUY_AND_HOLD = "MANUAL_BUY_AND_HOLD";

export function simulatePosition(input: SimulateInput): SimResult | { skip: string } {
  const { candles, meta, costs, sizeUsd } = input;
  const ref = refPrice(candles, input.entryTs);
  if (!ref || !(ref.price > 0)) return { skip: "no trade before entry time" };
  const entryTs = ref.ts;
  const entryMid = ref.price;
  const entryLiquidityUsd =
    meta.midAtDecision && meta.liquidityUsdAtDecision ? liquidityAt(meta.liquidityUsdAtDecision, meta.midAtDecision, entryMid) : meta.liquidityUsdAtDecision;
  const entryFill = input.entryFillOverride ?? buyFillPrice(entryMid, sizeUsd, entryLiquidityUsd, costs);
  const tokens = sizeUsd / entryFill;
  const entryMcap = meta.supply ? entryMid * meta.supply : undefined;
  const { exitRules, tier } = resolveTierPure(input.exitRules, { qualityScore: meta.qualityScore, entryMcap, socialScore: meta.socialScore });
  const manualHold = meta.qualificationPath === MANUAL_BUY_AND_HOLD;
  const endTs = Math.min(entryTs + (input.holdWindowS ?? DEFAULT_HOLD_WINDOW_S), input.coverageEnd);

  const markAt = (mid: number, remaining: number): number =>
    sellFillPrice(mid, remaining * tokens * mid, liquidityAt(entryLiquidityUsd, entryMid, mid), costs);

  // Live takes its stop baseline from the first mark, seconds after entry,
  // when the price hasn't moved: the entry-time price marked as a sell.
  const baseline = stopBaseline(entryFill, markAt(entryMid, 1));
  const legs: SimLeg[] = [];
  let remaining = 1;
  let realizedProceedsUsd = 0; // sells minus their gas, at the reference size (v1.9 cost recovery reads it)
  let mfePercent: number | null = null;
  let maePercent: number | null = null;
  let profitStepsTaken = 0;
  // ExitRules.stopConfirm's timer, driven by tick time the way live drives
  // it by mark time (nextStopBreach, positionManager.ts).
  let stopBreachSinceMs: number | undefined;
  let lastPrice = entryMid;
  let lastTs = entryTs;
  let exitReason = "";

  const evaluate = (tick: Tick): boolean => {
    const mark = markAt(tick.price, remaining);
    const currentMultiple = mark / entryFill;
    const pnl = (currentMultiple - 1) * 100;
    mfePercent = Math.max(mfePercent ?? pnl, pnl);
    maePercent = Math.min(maePercent ?? pnl, pnl);
    const liq = liquidityAt(entryLiquidityUsd, entryMid, tick.price);
    const holdingMs = (tick.ts - entryTs) * 1000;
    const stopPnlPercent = (mark / baseline - 1) * 100;
    const breach = nextStopBreach({ exitRules, stopPnlPercent, manualHold, sinceMs: stopBreachSinceMs, nowMs: tick.ts * 1000 });
    stopBreachSinceMs = breach.sinceMs;
    const trade = {
      id: "backtest",
      tradeLane: meta.tradeLane,
      openedAt: new Date(Date.now() - holdingMs),
      entryLiquidityUsd: entryLiquidityUsd ?? null,
      mfePercent,
      maePercent,
      actualEntryMcap: entryMcap ?? null,
      entryPriceUsd: entryFill,
      positionSizeUsd: sizeUsd,
    } as unknown as Trade;
    const ctx = {
      trade,
      plan: { invalidationMcap: meta.invalidationMcap },
      exitRules,
      currentMcap: meta.supply ? tick.price * meta.supply : undefined,
      currentMultiple,
      unrealizedPnlPercent: pnl,
      liquidityUsd: liq ?? 0,
      buySellRatio5m: undefined,
      totalTxns5m: meta.tradeLane === "NARRATIVE_TACTICAL" ? Number.MAX_SAFE_INTEGER : undefined,
      sellQuoteAvailable: true,
      remainingTokens: remaining * tokens,
      totalBoughtTokens: tokens,
      manualHold,
      stopPnlPercent,
      stopBreachSeconds: breach.seconds,
      // v1.9's costRecovery inputs; evaluateExits ignores them before v1.9.
      costBasisUsd: sizeUsd + costs.gasBuyUsd,
      realizedProceedsUsd,
      estimatedSellGasUsd: costs.gasSellUsd,
    };
    let decision = evaluateExits(ctx);
    if (input.legacyProfitSteps && (!decision || decision.type === "TRAILING_EXIT" || decision.type === "TIME_EXIT")) {
      const step = exitRules.profitSteps[profitStepsTaken];
      if (step && currentMultiple >= step.multiple) {
        decision = { type: "PARTIAL_PROFIT", sellPercentOfRemaining: step.sellPercentOfRemaining, reason: `profit target ${step.multiple}x`, isEmergency: false };
        decision = applyRunnerGuard(decision, meta.tradeLane, remaining);
        profitStepsTaken++;
      }
    }
    if (!decision) return false;
    const fillMid = tick.atHigh ? Math.min(tick.price, tick.barClose) : tick.price;
    const fraction = remaining * (decision.sellPercentOfRemaining / 100);
    if (!(fraction > 0)) return false;
    const legLiquidity = liquidityAt(entryLiquidityUsd, entryMid, fillMid);
    legs.push({ ts: tick.ts, fraction, mid: fillMid, liquidityUsd: legLiquidity, type: decision.type, reason: decision.reason });
    realizedProceedsUsd += fraction * tokens * sellFillPrice(fillMid, fraction * tokens * fillMid, legLiquidity, costs) - costs.gasSellUsd;
    remaining -= fraction;
    exitReason = `${decision.type}: ${decision.reason}`;
    return remaining <= 1e-9;
  };

  let closed = false;
  for (let i = ref.nextIdx; i < candles.length && !closed; i++) {
    const c = candles[i];
    if (c.t >= endTs) break;
    // Live ticks every few seconds even when nothing trades. The price can't
    // move then, but the clock can run into the underwater time exit.
    const timeExitAt = entryTs + exitRules.maxHoldMinutes * 60;
    if (timeExitAt > lastTs && timeExitAt < c.t && timeExitAt < endTs) {
      closed = evaluate({ ts: timeExitAt, price: lastPrice, atHigh: false, barClose: lastPrice });
      if (closed) break;
    }
    for (const tick of ticksOf(c, input.intrabar ?? "worst")) {
      if (tick.ts > endTs) break;
      closed = evaluate(tick);
      lastPrice = tick.price;
      lastTs = tick.ts;
      if (closed) break;
    }
  }
  if (!closed) {
    const timeExitAt = entryTs + exitRules.maxHoldMinutes * 60;
    if (timeExitAt > lastTs && timeExitAt < endTs) closed = evaluate({ ts: timeExitAt, price: lastPrice, atHigh: false, barClose: lastPrice });
  }
  if (!closed && remaining > 1e-9) {
    const openAtEnd = endTs >= input.coverageEnd && input.coverageEnd < entryTs + (input.holdWindowS ?? DEFAULT_HOLD_WINDOW_S);
    legs.push({
      ts: endTs,
      fraction: remaining,
      mid: lastPrice,
      liquidityUsd: liquidityAt(entryLiquidityUsd, entryMid, lastPrice),
      type: openAtEnd ? "DATA_END" : "WINDOW_END",
      reason: openAtEnd ? "still open when the data ends; marked at the last price" : "hold window over; sold at the last price",
    });
    exitReason = legs[legs.length - 1].type;
    remaining = 0;
  }

  const lastLeg = legs[legs.length - 1];
  return {
    entryTs,
    entryMid,
    entryFill,
    entryLiquidityUsd,
    tier,
    legs,
    peakMultiple: 1 + (mfePercent ?? 0) / 100,
    troughMultiple: 1 + (maePercent ?? 0) / 100,
    exitReason,
    holdMinutes: lastLeg ? (lastLeg.ts - entryTs) / 60 : 0,
  };
}

// positionManager.ts's applyVerifiedRunnerGuard, for the legacy ladder only
// (live decisions already come back from evaluateExits with it applied).
function applyRunnerGuard<T extends { sellPercentOfRemaining: number; reason: string }>(decision: T, lane: string | null, remaining: number): T | null {
  const retain = Number(process.env.MOONBAG_RETAIN_PERCENT ?? 15) / 100;
  if (lane !== "VERIFIED_PROJECT" || retain <= 0) return decision;
  const after = remaining * (1 - decision.sellPercentOfRemaining / 100);
  if (after >= retain) return decision;
  const maxSell = Math.max(0, remaining - retain);
  if (maxSell <= 1e-12) return null;
  return { ...decision, sellPercentOfRemaining: (maxSell / remaining) * 100 };
}

export interface ValuedLeg {
  ts: number;
  proceedsUsd: number;
  gasUsd: number;
}

export interface ValuedTrade {
  sizeUsd: number;
  proceedsUsd: number;
  gasUsd: number;
  netUsd: number;
  netPct: number; // net / size * 100, after slippage, impact and gas
  grossPct: number; // before gas
  legs: ValuedLeg[];
}

/** Re-prices a simulated trade at an actual size: impact scales with size, gas is per swap. */
export function valueAtSize(sim: SimResult, sizeUsd: number, costs: ChainCostModel, entryFillOverride?: number): ValuedTrade {
  const entryFill = entryFillOverride ?? buyFillPrice(sim.entryMid, sizeUsd, sim.entryLiquidityUsd, costs);
  const tokens = sizeUsd / entryFill;
  const legs = sim.legs.map((leg) => {
    const value = leg.fraction * tokens * leg.mid;
    return { ts: leg.ts, proceedsUsd: leg.fraction * tokens * sellFillPrice(leg.mid, value, leg.liquidityUsd, costs), gasUsd: costs.gasSellUsd };
  });
  const proceeds = legs.reduce((a, l) => a + l.proceedsUsd, 0);
  const gas = costs.gasBuyUsd + legs.reduce((a, l) => a + l.gasUsd, 0);
  const net = proceeds - sizeUsd - gas;
  return {
    sizeUsd,
    proceedsUsd: proceeds,
    gasUsd: gas,
    netUsd: net,
    netPct: (net / sizeUsd) * 100,
    grossPct: ((proceeds - sizeUsd) / sizeUsd) * 100,
    legs,
  };
}
