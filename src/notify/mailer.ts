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
  if (config.brevoApiKey) return sendViaBrevo(input);
  return sendViaSmtp(input);
}
