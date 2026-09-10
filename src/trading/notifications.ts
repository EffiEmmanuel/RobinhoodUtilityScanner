import { Resend } from "resend";
import { config } from "../config";
import { logger } from "../logger";
import { db } from "../db";
import type { Token, Trade } from "../generated/prisma";
import type { PaperQuote } from "./execution";
import { tradingConfig } from "./config";
import type { PortfolioState } from "./portfolio";

let resend: Resend | undefined;
function getResend(): Resend {
  if (!config.resendApiKey) throw new Error("RESEND_API_KEY is not set");
  if (!resend) resend = new Resend(config.resendApiKey);
  return resend;
}

// Every subject is tagged with the trading mode so a simulated trade can
// never be mistaken for a real one in an inbox — there is no LIVE mode in
// this build, but the tag stays correct if that ever changes.
function modeTag(): string {
  return `[${tradingConfig.mode}]`;
}

async function send(subject: string, text: string): Promise<void> {
  if (!config.alertEmailFrom || !config.alertEmailTo) {
    logger.warn("ALERT_EMAIL_FROM/ALERT_EMAIL_TO not configured; skipping trading email");
    return;
  }
  const result = await getResend().emails.send({
    from: config.alertEmailFrom,
    to: config.alertEmailTo,
    subject: `${modeTag()} ${subject}`,
    text,
  });
  if (result.error) throw new Error(`Resend send failed: ${result.error.message}`);
}

function tokenLabel(token: Token | null): string {
  return token?.name ?? token?.symbol ?? token?.address.slice(0, 10) ?? "unknown token";
}

export async function sendTradeEntryEmail(input: {
  token: Token | null;
  trade: Trade;
  quote: PaperQuote & { provider?: "paper" | "live"; txHash?: string };
}): Promise<void> {
  const isLive = input.quote.provider === "live";
  await send(
    `${isLive ? "REAL " : ""}Entry Executed — ${tokenLabel(input.token)}`,
    [
      `Token: ${tokenLabel(input.token)}`,
      `Contract: ${input.token?.address ?? "unknown"}`,
      `Amount invested: $${input.trade.positionSizeUsd.toFixed(2)}`,
      `Entry price (${isLive ? "real fill" : "simulated fill"}): $${input.quote.priceUsd}`,
      `Entry market cap: ${input.trade.actualEntryMcap ? `$${Math.round(input.trade.actualEntryMcap).toLocaleString()}` : "unknown"}`,
      `Token amount: ${input.quote.tokenAmount}`,
      isLive ? undefined : `Estimated slippage: ${(input.quote.estimatedSlippageBps / 100).toFixed(2)}%`,
      isLive ? undefined : `Estimated price impact: ${input.quote.estimatedPriceImpactPercent.toFixed(2)}%`,
      isLive && input.quote.txHash ? `Transaction: ${input.quote.txHash}` : undefined,
      "",
      isLive
        ? `THIS WAS A REAL ${tradingConfig.mode} TRADE — real funds were moved on Robinhood Chain.`
        : `This is a ${tradingConfig.mode} trade — no real funds were moved.`,
    ]
      .filter((line) => line !== undefined)
      .join("\n")
  );
}

export async function sendPartialProfitEmail(input: {
  tradeId: string;
  tokenId: string;
  multiple: number;
  sellPercent: number;
  mode?: string;
}): Promise<void> {
  const token = await db.token.findUnique({ where: { id: input.tokenId } });
  const isLive = input.mode === "LIVE";
  await send(
    `${isLive ? "REAL " : ""}Partial Profit — ${tokenLabel(token)} — ${input.multiple.toFixed(2)}x`,
    [
      `Token: ${tokenLabel(token)}`,
      `Sold ${input.sellPercent}% of remaining position at approximately ${input.multiple.toFixed(2)}x.`,
      `Trade ID: ${input.tradeId}`,
      "",
      isLive
        ? `THIS WAS A REAL trade — real funds were moved on Robinhood Chain.`
        : `This is a ${input.mode ?? tradingConfig.mode} trade — no real funds were moved.`,
    ].join("\n")
  );
}

export async function sendTradeClosedEmail(input: { token: Token | null; trade: Trade }): Promise<void> {
  const holdingMinutes =
    input.trade.openedAt && input.trade.closedAt
      ? Math.round((input.trade.closedAt.getTime() - input.trade.openedAt.getTime()) / 60_000)
      : undefined;
  const isLive = input.trade.mode === "LIVE";
  await send(
    `${isLive ? "REAL " : ""}Trade Closed — ${tokenLabel(input.token)} — ${input.trade.realizedMultiple ? `${input.trade.realizedMultiple.toFixed(2)}x` : "?"}`,
    [
      `Token: ${tokenLabel(input.token)}`,
      `Realized PnL: ${input.trade.realizedPnlUsd !== null ? `$${input.trade.realizedPnlUsd.toFixed(2)}` : "unknown"}`,
      `Realized multiple: ${input.trade.realizedMultiple ? `${input.trade.realizedMultiple.toFixed(2)}x` : "unknown"}`,
      `Holding time: ${holdingMinutes !== undefined ? `${holdingMinutes} minutes` : "unknown"}`,
      `MFE: ${input.trade.mfePercent !== null ? `${input.trade.mfePercent?.toFixed(1)}%` : "unknown"}`,
      `MAE: ${input.trade.maePercent !== null ? `${input.trade.maePercent?.toFixed(1)}%` : "unknown"}`,
      `Exit reason: ${input.trade.exitReason ?? "unknown"}`,
      "",
      isLive
        ? `THIS WAS A REAL trade — real funds were moved on Robinhood Chain.`
        : `This is a ${input.trade.mode} trade — no real funds were moved.`,
    ].join("\n")
  );
}

export async function sendTradePlanEmail(input: {
  token: Token | null;
  action: string;
  currentMcap?: number;
  targetMin?: number;
  targetMax?: number;
  doNotChaseAboveMcap?: number | null;
  invalidationMcap?: number | null;
  qualityScore?: number | null;
  researchConfidence?: number | null;
  riskScore?: number | null;
  confidence?: number | null;
  reasoning: string[];
}): Promise<void> {
  await send(
    `Trade Plan — ${tokenLabel(input.token)} — ${input.action}`,
    [
      `Token: ${tokenLabel(input.token)}`,
      `Contract: ${input.token?.address ?? "unknown"}`,
      `Action: ${input.action}`,
      input.qualityScore != null ? `Project quality: ${Math.round(input.qualityScore)}/100` : undefined,
      input.researchConfidence != null ? `Research confidence: ${Math.round(input.researchConfidence)}/100` : undefined,
      input.riskScore != null ? `AI market-timing risk: ${Math.round(input.riskScore)}/100` : undefined,
      input.confidence != null ? `AI confidence in this read: ${Math.round(input.confidence)}/100` : undefined,
      input.currentMcap ? `Current market cap: $${Math.round(input.currentMcap).toLocaleString()}` : undefined,
      input.targetMin && input.targetMax
        ? `Target entry zone: $${Math.round(input.targetMin).toLocaleString()} - $${Math.round(input.targetMax).toLocaleString()}`
        : undefined,
      input.doNotChaseAboveMcap != null ? `Do not chase above: $${Math.round(input.doNotChaseAboveMcap).toLocaleString()}` : undefined,
      input.invalidationMcap != null ? `Technical invalidation: $${Math.round(input.invalidationMcap).toLocaleString()}` : undefined,
      "",
      "Reasoning:",
      ...input.reasoning.map((r) => `- ${r}`),
    ]
      .filter(Boolean)
      .join("\n")
  );
}

export async function sendMilestoneEmail(input: { targetUsd: number; portfolio: PortfolioState }): Promise<void> {
  await send(
    `Portfolio Milestone — Hit $${input.targetUsd.toLocaleString()}`,
    [
      `Current equity: $${input.portfolio.totalEquityUsd.toFixed(2)}`,
      `Cash: $${input.portfolio.cashUsd.toFixed(2)}`,
      `Open positions: ${input.portfolio.openPositionCount}`,
      `Reserve target: $${input.portfolio.reserveTargetUsd.toFixed(2)}`,
      "",
      `This is a ${tradingConfig.mode} portfolio — no real funds are involved.`,
    ].join("\n")
  );
}
