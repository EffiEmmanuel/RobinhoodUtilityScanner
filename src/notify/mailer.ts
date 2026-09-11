import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "../config";

// Free SMTP relay (Gmail App Password by default) in place of Resend, which
// hit its monthly send cap. Regular Gmail allows 500 sends/24hr, Google
// Workspace 2000/24hr — either way, point SMTP_USER/SMTP_PASS/ALERT_EMAIL_FROM
// at the account that should send, no code change needed.
let transporter: Transporter | undefined;
function getTransporter(): Transporter {
  if (!config.smtpUser || !config.smtpPass) throw new Error("SMTP_USER/SMTP_PASS are not set");
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465, // 465 = implicit TLS; 587/25 use STARTTLS
      auth: { user: config.smtpUser, pass: config.smtpPass },
    });
  }
  return transporter;
}

export interface MailInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendMail(input: MailInput): Promise<string | undefined> {
  try {
    const info = await getTransporter().sendMail(input);
    return info.messageId;
  } catch (err) {
    throw new Error(`SMTP send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
