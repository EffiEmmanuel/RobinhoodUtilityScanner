import { tradingConfig } from "./config";

// §26 global kill switch: TRADING_ENABLED in .env sets the boot-time default;
// POST /trading/pause|resume flips this in-memory override at runtime without
// a restart. Exits must keep working regardless of this flag (see
// riskEngine.validateExit, which never checks it) — only new entries do.
let tradingEnabledOverride: boolean | undefined;

export function isTradingEnabled(): boolean {
  return tradingEnabledOverride ?? tradingConfig.tradingEnabled;
}

export function setTradingEnabled(enabled: boolean): void {
  tradingEnabledOverride = enabled;
}
