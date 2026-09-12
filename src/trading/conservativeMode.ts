import { tradingConfig } from "./config";

/**
 * Conservative mode — what a tripped LOSS breaker (daily realized loss or
 * consecutive losses, see portfolio.ts's checkCircuitBreakers) does instead of
 * pausing new entries outright. User directive 2026-09-11: keep detecting,
 * planning and sniping, but only buy setups we can be very confident in.
 * Exits are untouched.
 *
 * This file also holds two checks that are NOT conservative-only —
 * evaluateChaseGuard and evaluateQuoteAgreement — added to normal-mode
 * entries too on 2026-09-12 (docs/trade-reviews/2026-09-11.md's "still to
 * decide" #1). Both take their threshold as a parameter for exactly that
 * reason: conservative mode calls them stricter than normal mode does.
 * evaluateHighConvictionSetup, the rest of the bundle, stays conservative-
 * mode-only.
 *
 * Everything here is pure (no DB, no network) so the gates can be tested
 * directly; entryMonitor.ts gathers the inputs. The evidence behind each
 * threshold is on its tradingConfig entry and in
 * docs/trade-reviews/2026-09-11.md.
 */

export type EntryMode = "NORMAL" | "CONSERVATIVE" | "PAUSED";

export interface EntryModeInput {
  // Breakers that stop entries no matter what (kill switch, low gas, position
  // count) — conservative mode never softens these.
  hardPauseReasons: string[];
  dailyRealizedLossPercent: number; // 0 when today is flat or up
  consecutiveLosses: number;
}

export interface EntryModeResult {
  mode: EntryMode;
  reasons: string[];
}

export function resolveEntryMode(input: EntryModeInput): EntryModeResult {
  const lossReasons: string[] = [];
  if (input.dailyRealizedLossPercent >= tradingConfig.maxDailyRealizedLossPercent) {
    lossReasons.push(`daily realized loss ${input.dailyRealizedLossPercent.toFixed(1)}% >= ${tradingConfig.maxDailyRealizedLossPercent}% limit`);
  }
  if (input.consecutiveLosses >= tradingConfig.maxConsecutiveLosses) {
    lossReasons.push(`${input.consecutiveLosses} consecutive losses`);
  }

  if (input.hardPauseReasons.length > 0) {
    return { mode: "PAUSED", reasons: [...input.hardPauseReasons, ...lossReasons] };
  }
  if (lossReasons.length === 0) return { mode: "NORMAL", reasons: [] };
  if (!tradingConfig.conservativeModeEnabled) return { mode: "PAUSED", reasons: lossReasons };

  // Conservative mode keeps trading, so it needs its own ceiling — without
  // one, a loss breaker would never stop anything again.
  const hardStopReasons: string[] = [];
  if (input.dailyRealizedLossPercent >= tradingConfig.conservativeHardStopDailyLossPercent) {
    hardStopReasons.push(
      `daily realized loss ${input.dailyRealizedLossPercent.toFixed(1)}% >= ${tradingConfig.conservativeHardStopDailyLossPercent}% conservative-mode hard stop`
    );
  }
  if (input.consecutiveLosses >= tradingConfig.conservativeHardStopConsecutiveLosses) {
    hardStopReasons.push(
      `${input.consecutiveLosses} consecutive losses >= ${tradingConfig.conservativeHardStopConsecutiveLosses} conservative-mode hard stop`
    );
  }
  if (hardStopReasons.length > 0) return { mode: "PAUSED", reasons: hardStopReasons };

  return { mode: "CONSERVATIVE", reasons: lossReasons };
}

// DexScreener's pairCreatedAt for this chain reads about an hour in the
// future — checked 2026-09-11: for 187 of 344 candidates it was LATER than the
// moment we researched the token, clustered 51-59 minutes ahead.
const PAIR_CREATED_AT_SKEW_MINUTES = 60;

/**
 * Our own Token.firstSeenAt is reliable but only starts when we noticed the
 * token, which can be long after launch; pairCreatedAt knows the launch but is
 * skewed (above). Take whichever shows the token is older, after removing the
 * full skew, so neither source can overstate age.
 */
export function estimateTokenAgeMinutes(firstSeenAt: Date, pairCreatedAt: Date | undefined, now: Date = new Date()): number {
  const sinceFirstSeen = (now.getTime() - firstSeenAt.getTime()) / 60_000;
  const sincePairCreated = pairCreatedAt
    ? (now.getTime() - pairCreatedAt.getTime()) / 60_000 - PAIR_CREATED_AT_SKEW_MINUTES
    : Number.NEGATIVE_INFINITY;
  return Math.max(sinceFirstSeen, sincePairCreated);
}

// The AI plan's own directional red flags. Every 2026-09-11 trade it labelled
// DISTRIBUTION, PARABOLIC or PULLBACK (ladybug, PONSFLY, Sheared, OPAI,
// moltfly) collapsed afterwards — the system bought anyway because a
// WAIT_FOR_ENTRY zone or a momentum override fired — and across candidates
// those labels fell 50%+ within 24h 55-82% of the time. Conservative mode
// takes the AI at its word on these, and treats "can't tell" as not confident
// either. LOW_LIQUIDITY isn't here: the liquidity check measures that directly.
export const CONSERVATIVE_EXCLUDED_REGIMES = ["PARABOLIC", "DISTRIBUTION", "PULLBACK", "TRENDING_DOWN", "UNKNOWN"];

export interface RecentPriceRange {
  snapshotCount: number;
  runUpPercent: number; // current mcap vs the window's low
  drawdownPercent: number; // current mcap vs the window's high, as a positive number
}

export interface HighConvictionInput {
  tokenAgeMinutes: number;
  liquidityUsd: number | undefined;
  buys1h: number | undefined;
  sells1h: number | undefined;
  volume1hUsd: number | undefined;
  priceChange5mPercent: number | undefined;
  priceChange1hPercent: number | undefined;
  // From our own MarketSnapshot history (see marketAnalysis.ts's
  // getRecentMcapRange); undefined when there's no current mcap to place.
  recent: RecentPriceRange | undefined;
  marketRegime: string | undefined;
  planRiskScore: number | null | undefined;
}

export interface ConvictionResult {
  passed: boolean;
  // Stable check names (for spotting a repeat of the same deferral) next to
  // the human-readable reasons, which carry the live numbers.
  failedChecks: string[];
  reasons: string[];
}

export interface ChaseGuardOptions {
  windowMinutes: number;
  minSnapshots: number;
  maxRunUpPercent: number;
}

/**
 * Blocks buying a token that's already run up hard in our OWN recent
 * snapshot history — not DexScreener's 5m change, which lags on this chain
 * (see RecentPriceRange's doc comment on marketAnalysis.ts's
 * getRecentMcapRange). Added to EVERY mode on 2026-09-12, not just
 * conservative: BLACKHOLE, PONSIBLE, THREE and MARRONA (-$9.90 combined) were
 * each bought 37-54% above their own 10-minute low, with buyers no more than
 * sellers — this alone would have blocked all four.
 */
export function evaluateChaseGuard(recent: RecentPriceRange | undefined, opts: ChaseGuardOptions): ConvictionResult {
  if (!recent || recent.snapshotCount < opts.minSnapshots) {
    return {
      passed: false,
      failedChecks: ["recentHistory"],
      reasons: [`only ${recent?.snapshotCount ?? 0} of our own price snapshots in the last ${opts.windowMinutes} min (need ${opts.minSnapshots})`],
    };
  }
  if (recent.runUpPercent > opts.maxRunUpPercent) {
    return {
      passed: false,
      failedChecks: ["recentRunUp"],
      reasons: [`already up ${recent.runUpPercent.toFixed(0)}% in the last ${opts.windowMinutes} min (> ${opts.maxRunUpPercent}%) — chasing`],
    };
  }
  return { passed: true, failedChecks: [], reasons: [] };
}

export function evaluateHighConvictionSetup(input: HighConvictionInput): ConvictionResult {
  const c = tradingConfig;
  const failedChecks: string[] = [];
  const reasons: string[] = [];
  const fail = (check: string, reason: string) => {
    failedChecks.push(check);
    reasons.push(reason);
  };

  if (input.tokenAgeMinutes < c.conservativeMinTokenAgeMinutes) {
    fail("tokenAge", `token is ~${Math.max(0, Math.round(input.tokenAgeMinutes))} min old (< ${c.conservativeMinTokenAgeMinutes})`);
  }

  const liquidityUsd = input.liquidityUsd ?? 0;
  if (liquidityUsd < c.conservativeMinLiquidityUsd) {
    fail("liquidity", `liquidity $${Math.round(liquidityUsd).toLocaleString()} < $${c.conservativeMinLiquidityUsd.toLocaleString()}`);
  }

  const hourlyTxns = (input.buys1h ?? 0) + (input.sells1h ?? 0);
  if (hourlyTxns < c.conservativeMinHourlyTxns) {
    fail("hourlyTxns", `${hourlyTxns} txns in the last hour (< ${c.conservativeMinHourlyTxns})`);
  }
  if (hourlyTxns > 0) {
    const buyRatio = (input.buys1h ?? 0) / hourlyTxns;
    if (buyRatio < c.conservativeMinBuyRatio1h || buyRatio > c.conservativeMaxBuyRatio1h) {
      fail(
        "buyRatio",
        `1h buy ratio ${(buyRatio * 100).toFixed(0)}% outside ${(c.conservativeMinBuyRatio1h * 100).toFixed(0)}-${(c.conservativeMaxBuyRatio1h * 100).toFixed(0)}%`
      );
    }
  }

  if (input.volume1hUsd === undefined) {
    fail("volumeToLiquidity", "no 1h volume data to rule out churn");
  } else if (liquidityUsd > 0 && input.volume1hUsd / liquidityUsd > c.conservativeMaxVolumeToLiquidity1h) {
    fail("volumeToLiquidity", `1h volume is ${(input.volume1hUsd / liquidityUsd).toFixed(1)}x liquidity (> ${c.conservativeMaxVolumeToLiquidity1h}x)`);
  }

  const pc1h = input.priceChange1hPercent;
  if (pc1h === undefined) {
    fail("priceChange1h", "no 1h price change data");
  } else if (pc1h <= c.conservativeMinPriceChange1hPercent || pc1h >= c.conservativeMaxPriceChange1hPercent) {
    fail("priceChange1h", `1h price change ${pc1h.toFixed(0)}% outside ${c.conservativeMinPriceChange1hPercent}% to +${c.conservativeMaxPriceChange1hPercent}%`);
  }

  const pc5m = input.priceChange5mPercent;
  if (pc5m === undefined) {
    fail("priceChange5m", "no 5m price change data");
  } else if (pc5m <= c.conservativeMinPriceChange5mPercent || pc5m >= c.conservativeMaxPriceChange5mPercent) {
    fail("priceChange5m", `5m price change ${pc5m.toFixed(0)}% outside ${c.conservativeMinPriceChange5mPercent}% to +${c.conservativeMaxPriceChange5mPercent}%`);
  }

  // The chase half of this lives in evaluateChaseGuard below (shared with
  // normal mode) — same window/threshold, so calling it here changes nothing
  // for conservative mode, it just stops the logic existing twice.
  const recent = input.recent;
  const window = c.conservativeRecentWindowMinutes;
  const chase = evaluateChaseGuard(recent, {
    windowMinutes: window,
    minSnapshots: c.conservativeMinRecentSnapshots,
    maxRunUpPercent: c.conservativeMaxRecentRunUpPercent,
  });
  if (!chase.passed) {
    failedChecks.push(...chase.failedChecks);
    reasons.push(...chase.reasons);
  }
  // Drawdown (falling-knife) stays conservative-only — normal mode doesn't
  // ask for this one.
  if (recent && recent.snapshotCount >= c.conservativeMinRecentSnapshots && recent.drawdownPercent > c.conservativeMaxRecentDrawdownPercent) {
    fail("recentDrawdown", `down ${recent.drawdownPercent.toFixed(0)}% from its ${window}-min high (> ${c.conservativeMaxRecentDrawdownPercent}%) — falling knife`);
  }

  if (!input.marketRegime || CONSERVATIVE_EXCLUDED_REGIMES.includes(input.marketRegime)) {
    fail("marketRegime", `AI read the chart as ${input.marketRegime ?? "unknown"}`);
  }
  if (input.planRiskScore == null) {
    fail("planRisk", "AI plan has no risk score");
  } else if (input.planRiskScore >= c.conservativeMaxPlanRiskScore) {
    fail("planRisk", `AI plan risk score ${input.planRiskScore} (>= ${c.conservativeMaxPlanRiskScore})`);
  }

  return { passed: failedChecks.length === 0, failedChecks, reasons };
}

/**
 * DexScreener's price and the price we'd actually fill at should roughly
 * agree. When the chain gives far MORE tokens than DexScreener's price
 * implies, the setup we just evaluated isn't the market we'd be buying into:
 * either DexScreener hasn't caught up with a collapse yet, or it's pricing a
 * different pool. On 2026-09-11 PONSFLY, Sheared, OPAI, ladybug and moltfly
 * filled 39-84% below the displayed price, and all five were collapsing.
 * TUMBLE filled 25% below during a genuine dip and was the day's best trade —
 * why this takes its cutoff as a parameter instead of hardcoding one: added
 * to normal-mode entries on 2026-09-12 with a looser cutoff
 * (normalMaxQuoteDiscountPercent, ~30%) than conservative mode's
 * (conservativeMaxQuoteDiscountPercent, ~10%) precisely so TUMBLE's kind of
 * trade isn't blocked outside conservative mode. Paying ABOVE the displayed
 * price is already bounded by validateEntry's price-impact limit.
 */
export function evaluateQuoteAgreement(
  input: { spotPriceUsd: number | undefined; positionSizeUsd: number; quotedTokenAmount: number },
  maxDiscountPercent: number
): ConvictionResult {
  if (!input.spotPriceUsd || input.spotPriceUsd <= 0 || input.quotedTokenAmount <= 0) {
    return { passed: false, failedChecks: ["quoteAgreement"], reasons: ["no usable on-chain quote to cross-check DexScreener's price against"] };
  }
  const quotedPriceUsd = input.positionSizeUsd / input.quotedTokenAmount;
  const discountPercent = ((input.spotPriceUsd - quotedPriceUsd) / input.spotPriceUsd) * 100;
  if (discountPercent > maxDiscountPercent) {
    return {
      passed: false,
      failedChecks: ["quoteAgreement"],
      reasons: [`on-chain quote is ${discountPercent.toFixed(0)}% below DexScreener's price (> ${maxDiscountPercent}%) — its data is stale or pricing a different pool`],
    };
  }
  return { passed: true, failedChecks: [], reasons: [] };
}

/**
 * True once our own snapshot history shows a WAIT_FOR_ENTRY pullback has
 * actually paused — this tick's mcap reading isn't lower than the one before
 * it. False whenever there are fewer than 2 readings to compare, so a zone
 * can never trigger on its very first, still-in-freefall touch. User
 * directive 2026-09-12: PONSFLY, Sheared and FFSTR all triggered their
 * pullback zone while still actively falling — the "pullback" was the dump,
 * not a bottom — and went on to 0.01x-0.14x of entry within hours.
 * `readings` is oldest-first; only the last two matter.
 */
export function hasPriceStabilized(readings: number[]): boolean {
  if (readings.length < 2) return false;
  const [previous, current] = readings.slice(-2);
  return current >= previous;
}
