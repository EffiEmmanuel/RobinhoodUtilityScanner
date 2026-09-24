import dns from "node:dns";
import net from "node:net";
import nodemailer from "nodemailer";
import { config } from "../config";
import { logger } from "../logger";
import { fetchJsonWithRetry } from "../util/http";

// Free SMTP relay (Gmail App Password by default) in place of Resend, which
// hit its monthly send cap. Regular Gmail allows 500 sends/24hr, Google
// Workspace 2000/24hr — either way, point SMTP_USER/SMTP_PASS/ALERT_EMAIL_FROM
// at the account that should send, no code change needed.

// Confirmed in prod logs 2026-09-16: sends were still failing roughly half
// the time with "connect ENETUNREACH <ipv6>:465" despite index.ts's
// dns.setDefaultResultOrder("ipv4first"). Root cause: nodemailer >=10
// resolves A and AAAA records itself and then picks a RANDOM address from
// the combined list (see resolveHostname/formatDNSValue in
// nodemailer/dist/cjs/shared/index.js) — it never consults Node's global DNS
// order. Railway has no outbound IPv6 route to smtp.gmail.com, so any time
// that random pick landed on an AAAA address the connection was DOA.
// Resolving the A record ourselves and connecting to that literal IPv4
// address (with `servername` set so TLS/SNI still validates against the
// real hostname) keeps nodemailer's resolver out of the picture entirely.
const SMTP_IP_TTL_MS = 5 * 60 * 1000;
let cachedSmtpIp: { host: string; address: string; expires: number } | undefined;

async function resolveSmtpHost(host: string): Promise<string> {
  if (net.isIP(host)) return host;
  if (cachedSmtpIp && cachedSmtpIp.host === host && cachedSmtpIp.expires > Date.now()) {
    return cachedSmtpIp.address;
  }
  try {
    const addresses = await dns.promises.resolve4(host);
    if (addresses.length > 0) {
      const address = addresses[Math.floor(Math.random() * addresses.length)];
      cachedSmtpIp = { host, address, expires: Date.now() + SMTP_IP_TTL_MS };
      return address;
    }
  } catch (err) {
    logger.warn(
      { host, err: err instanceof Error ? err.message : String(err) },
      "IPv4 resolution for SMTP host failed, falling back to hostname (may hit an unreachable IPv6 address)"
    );
  }
  return host;
}

export interface MailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// Parses the "Name <email@host>" format used everywhere ALERT_EMAIL_FROM is
// read from — falls back to treating the whole string as a bare email when
// there's no angle-bracket name, which is the same shape nodemailer accepts.
function parseAddress(raw: string): { name?: string; email: string } {
  const match = raw.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
  if (match) return { name: match[1] || undefined, email: match[2] };
  return { email: raw.trim() };
}

/**
 * Confirmed live 2026-09-17: raw SMTP to smtp.gmail.com:465 from Railway
 * went to 0 successes / 26 failures ("Connection timeout") over ~3.6h — see
 * config.ts's brevoApiKey doc comment. Brevo's HTTPS API sidesteps whatever
 * is blocking the SMTP port entirely, since it's a normal port-443 request
 * fetchJsonWithRetry already knows how to retry/back off.
 */
async function sendViaBrevo(input: MailInput): Promise<string | undefined> {
  const from = parseAddress(input.from);
  const to = parseAddress(input.to);
  const result = await fetchJsonWithRetry<{ messageId?: string }>(
    "https://api.brevo.com/v3/smtp/email",
    {
      method: "POST",
      headers: { "api-key": config.brevoApiKey!, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: from.email, name: from.name },
        to: [{ email: to.email, name: to.name }],
        subject: input.subject,
        textContent: input.text,
        ...(input.html ? { htmlContent: input.html } : {}),
      }),
    },
    { retries: 3, timeoutMs: 15_000 }
  );
  logger.info({ to: input.to, subject: input.subject, messageId: result.messageId }, "email accepted by Brevo API");
  return result.messageId;
}

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_DOMAINS_URL = "https://api.resend.com/domains";
const RESEND_TIMEOUT_MS = 15_000;
const resendCooldownUntil = new Map<string, number>();
const resendSenderByKey = new Map<string, string>();

/**
 * The sender a Resend account can email ALERT_EMAIL_TO from: an address on
 * the account's first verified domain, keeping RESEND_FROM's display name.
 * Without a verified domain, Resend only lets an account email its own
 * owner (confirmed live 2026-09-24: the re_2Cu5 account is registered to a
 * different Gmail than ALERT_EMAIL_TO and was refused until it sent from
 * its own domain), so RESEND_FROM's shared test address is the fallback.
 */
export function resendSenderAddress(defaultFrom: string, domains: { name: string; status: string }[]): string {
  const domain = domains.find((d) => d.status === "verified")?.name;
  if (!domain) return defaultFrom;
  const { name } = parseAddress(defaultFrom);
  return name ? `${name} <alerts@${domain}>` : `alerts@${domain}`;
}

/** Looked up once per key. A 401/403 (a sending-only key can't list
 * domains) is cached as the fallback too; a network error or 5xx isn't, so
 * the next email looks again. */
async function resendSenderFor(key: string): Promise<string> {
  const cached = resendSenderByKey.get(key);
  if (cached) return cached;
  try {
    const res = await fetch(RESEND_DOMAINS_URL, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(RESEND_TIMEOUT_MS) });
    if (res.ok) {
      const body = (await res.json()) as { data?: { name: string; status: string }[] };
      const sender = resendSenderAddress(config.resendFrom, body.data ?? []);
      resendSenderByKey.set(key, sender);
      return sender;
    }
    if (res.status === 401 || res.status === 403) resendSenderByKey.set(key, config.resendFrom);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "Resend domain lookup failed, sending from RESEND_FROM");
  }
  return config.resendFrom;
}

/**
 * How long a Resend key sits out after Resend refuses it. Quota errors clear
 * on their own (the daily one within a day), so the key is re-tried hourly.
 * A 401/403 means the key can't deliver at all until a human fixes the
 * account (revoked key, or testing mode refusing a recipient that isn't the
 * account owner), so it's re-tried rarely. Anything else — the per-second
 * rate limit, a 5xx, a timeout — only moves this one email to the next key.
 */
export function resendCooldownMs(status: number, errorName?: string): number {
  if (errorName === "daily_quota_exceeded" || errorName === "monthly_quota_exceeded") return 60 * 60_000;
  if (status === 401 || status === 403) return 6 * 60 * 60_000;
  return 0;
}

/** Keys in priority order, minus the ones sitting out — or all of them when
 * every key is, since a cooldown is only an estimate and dropping the email
 * is worse than one more refused request. */
export function resendKeyOrder(keys: string[], cooldownUntil: ReadonlyMap<string, number>, now: number): string[] {
  const ready = keys.filter((key) => (cooldownUntil.get(key) ?? 0) <= now);
  return ready.length > 0 ? ready : keys;
}

/**
 * Resend is tried key by key in RESEND_API_KEYS priority order (config.ts),
 * so one account hitting its free-tier cap doesn't stop alerts. Uses plain
 * fetch rather than fetchJsonWithRetry: which key to try next depends on
 * Resend's error name, and fetchJsonWithRetry's errors drop the body. The
 * sender comes from each key's own account (resendSenderFor), never
 * ALERT_EMAIL_FROM, since Resend refuses unverified sender domains like
 * that gmail.com one.
 */
async function sendViaResend(input: MailInput): Promise<string | undefined> {
  let lastError = "no keys";
  for (const key of resendKeyOrder(config.resendApiKeys, resendCooldownUntil, Date.now())) {
    const keyNumber = config.resendApiKeys.indexOf(key) + 1; // never log the key itself
    try {
      const from = await resendSenderFor(key);
      const res = await fetch(RESEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          ...(input.html ? { html: input.html } : {}),
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; message?: string };
      if (res.ok) {
        resendCooldownUntil.delete(key);
        logger.info({ to: input.to, from, subject: input.subject, messageId: body.id, keyNumber }, "email accepted by Resend");
        return body.id;
      }
      const cooldownMs = resendCooldownMs(res.status, body.name);
      if (cooldownMs > 0) resendCooldownUntil.set(key, Date.now() + cooldownMs);
      lastError = `HTTP ${res.status} ${body.name ?? ""}: ${body.message ?? ""}`;
      logger.warn(
        { keyNumber, status: res.status, error: body.name, message: body.message, cooldownMinutes: cooldownMs / 60_000 },
        "Resend refused the email on this key, trying the next one"
      );
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn({ keyNumber, err: lastError }, "Resend request failed on this key, trying the next one");
    }
  }
  throw new Error(`Resend send failed on every key: ${lastError}`);
}

async function sendViaSmtp(input: MailInput): Promise<string | undefined> {
  if (!config.smtpUser || !config.smtpPass) throw new Error("SMTP_USER/SMTP_PASS are not set");
  try {
    const host = await resolveSmtpHost(config.smtpHost);
    const transporter = nodemailer.createTransport({
      host,
      port: config.smtpPort,
      secure: config.smtpPort === 465, // 465 = implicit TLS; 587/25 use STARTTLS
      servername: config.smtpHost, // preserve cert/SNI validation now that `host` may be a literal IP
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
    const info = await transporter.sendMail(input);
    logger.info({ to: input.to, subject: input.subject, messageId: info.messageId }, "email accepted by SMTP relay");
    return info.messageId;
  } catch (err) {
    throw new Error(`SMTP send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function sendMail(input: MailInput): Promise<string | undefined> {
  if (config.resendApiKeys.length > 0) return sendViaResend(input);
  if (config.brevoApiKey) return sendViaBrevo(input);
  return sendViaSmtp(input);
}
