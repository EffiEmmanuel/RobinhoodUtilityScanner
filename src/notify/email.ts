import { Resend } from "resend";
import { config } from "../config";
import { logger } from "../logger";
import type { ScoringResult } from "../scoring";
import type { ResearchSynthesis } from "../ai/schemas";

let resend: Resend | undefined;
function getResend(): Resend {
  if (!config.resendApiKey) throw new Error("RESEND_API_KEY is not set");
  if (!resend) resend = new Resend(config.resendApiKey);
  return resend;
}

export interface AlertEmailInput {
  tokenName?: string | null;
  tokenSymbol?: string | null;
  tokenAddress: string;
  detectedAt: Date;
  researchCompletedAt: Date;
  score: ScoringResult;
  synthesis: ResearchSynthesis;
  links: { label: string; url: string }[];
  marketSummaryText: string;
}

function fmtScore(n: number) {
  return Math.round(n);
}

export function buildAlertSubject(input: AlertEmailInput): string {
  const name = input.tokenName ?? input.tokenSymbol ?? input.tokenAddress.slice(0, 10);
  return `\u{1F6A8} RH Utility Candidate — ${name} — ${fmtScore(input.score.finalScore)}/100`;
}

export function buildAlertPlainText(input: AlertEmailInput): string {
  const f = input.score.factors;
  const lines = [
    `Project: ${input.tokenName ?? "(unknown)"}`,
    `Ticker: ${input.tokenSymbol ?? "(unknown)"}`,
    `Contract: ${input.tokenAddress}`,
    `Score: ${fmtScore(input.score.finalScore)}/100 (${input.score.band})`,
    `Confidence: ${input.score.confidence}/100`,
    "",
    `Detected: ${input.detectedAt.toISOString()}`,
    `Research completed: ${input.researchCompletedAt.toISOString()}`,
    "",
    "SUMMARY",
    input.synthesis.projectSummary,
    "",
    "WHY IT PASSED",
    ...(input.synthesis.positives.length ? input.synthesis.positives.map((p) => `• ${p}`) : ["(none recorded)"]),
    "",
    "RISKS",
    ...(input.synthesis.risks.length ? input.synthesis.risks.map((r) => `• ${r}`) : ["(none recorded)"]),
    "",
    "MARKET",
    input.marketSummaryText,
    "",
    "SCORES",
    `Utility: ${fmtScore(f.utility.score)}`,
    `Contract: ${fmtScore(f.contract.score)}`,
    `Credibility: ${fmtScore(f.credibility.score)}`,
    `Website: ${fmtScore(f.website.score)}`,
    `Social: ${fmtScore(f.social.score)}`,
    `Liquidity: ${fmtScore(f.liquidity.score)}`,
    `Market: ${fmtScore(f.market.score)}`,
    `Holders: ${fmtScore(f.holders.score)} (confidence: ${f.holders.confidence})`,
    `Team: ${fmtScore(f.team.score)}`,
    `Branding: ${fmtScore(f.branding.score)}`,
    "",
    "LINKS",
    ...input.links.map((l) => `${l.label}: ${l.url}`),
  ];
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

export function buildAlertHtml(input: AlertEmailInput): string {
  const text = buildAlertPlainText(input);
  return `<pre style="font-family: ui-monospace, monospace; white-space: pre-wrap; font-size: 13px;">${escapeHtml(text)}</pre>`;
}

/**
 * Fired the moment ai/provider.ts rotates off an exhausted Gemini key — most
 * important the first time (index 0 -> 1), since that's the paid key running
 * dry and needing a top-up. Fire-and-forget from the caller's perspective:
 * never let an alert-email failure break classification/research.
 */
export async function sendGeminiKeyRotationAlert(input: {
  fromKeyIndex: number;
  toKeyIndex: number;
  totalKeys: number;
  errorMessage: string;
}): Promise<void> {
  if (!config.alertEmailFrom || !config.alertEmailTo) {
    logger.warn("ALERT_EMAIL_FROM/ALERT_EMAIL_TO not configured; skipping Gemini key rotation alert");
    return;
  }
  const keyLabel = input.fromKeyIndex === 0 ? "your primary (paid) key" : `backup key #${input.fromKeyIndex + 1}`;
  const subject = `⚠️ Gemini ${keyLabel} ran out — now on key ${input.toKeyIndex + 1} of ${input.totalKeys}`;
  const text = [
    `${keyLabel[0].toUpperCase()}${keyLabel.slice(1)} for the Gemini API just ran out of usable quota/credits.`,
    `The bot automatically switched to key #${input.toKeyIndex + 1} of ${input.totalKeys} — classification and research keep running, nothing stopped.`,
    "",
    input.fromKeyIndex === 0
      ? "Top up billing/credits on the primary Google Cloud project to switch back to it — the bot will keep using the backup key until then."
      : "This was already a backup key, so all configured keys may now be low — check billing on each.",
    "",
    `Error seen: ${input.errorMessage}`,
  ].join("\n");
  try {
    await getResend().emails.send({ from: config.alertEmailFrom, to: config.alertEmailTo, subject, text });
  } catch (err) {
    logger.error({ err: String(err) }, "failed to send Gemini key rotation alert email");
  }
}

export async function sendAlertEmail(input: AlertEmailInput): Promise<string | undefined> {
  if (!config.alertEmailFrom || !config.alertEmailTo) {
    logger.warn("ALERT_EMAIL_FROM/ALERT_EMAIL_TO not configured; skipping email send");
    return undefined;
  }
  const result = await getResend().emails.send({
    from: config.alertEmailFrom,
    to: config.alertEmailTo,
    subject: buildAlertSubject(input),
    text: buildAlertPlainText(input),
    html: buildAlertHtml(input),
  });
  if (result.error) {
    throw new Error(`Resend send failed: ${result.error.message}`);
  }
  return result.data?.id;
}
