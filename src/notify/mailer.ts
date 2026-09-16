import dns from "node:dns";
import net from "node:net";
import nodemailer from "nodemailer";
import { config } from "../config";
import { logger } from "../logger";

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

export async function sendMail(input: MailInput): Promise<string | undefined> {
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
