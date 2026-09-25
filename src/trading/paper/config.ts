/**
 * Paper-strategy settings, read from the environment directly so the live
 * trading config stays untouched. Everything defaults to off or cautious.
 */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const paperConfig = {
  enabled: process.env.PAPER_STRATEGIES_ENABLED === "true",
  tickSeconds: num("PAPER_TICK_SECONDS", 30),
  // Counted in-process, reset at UTC midnight. Past it, marks are skipped and
  // positions keep their last mark (logged once a day).
  maxQuotesPerDay: num("PAPER_MAX_QUOTES_PER_DAY", 15_000),
  maxOpenPerStrategy: num("PAPER_MAX_OPEN_PER_STRATEGY", 10),
  // The backtester's hold window: a paper position still open this long is
  // sold at its mark, so a strategy's slots don't fill with stale holds.
  maxHoldHours: num("PAPER_MAX_HOLD_HOURS", 48),
  // No sell route for this long is treated as unsellable: written off at 0.
  writeOffAfterNoQuoteHours: num("PAPER_WRITE_OFF_AFTER_NO_QUOTE_HOURS", 6),
  equitySnapshotMinutes: num("PAPER_EQUITY_SNAPSHOT_MINUTES", 5),
  // Modeled per-swap gas (calibrated 2026-09-25 from our Solana fills).
  gasBuyUsd: num("PAPER_GAS_BUY_USD", 0.01),
  gasSellUsd: num("PAPER_GAS_SELL_USD", 0.014),
  slippageBps: num("PAPER_QUOTE_SLIPPAGE_BPS", 300),
};
