import nodemailer from "nodemailer";

import {
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM_NAME,
} from "./env";

export const accountEmail = SMTP_USER;
export const fromName = SMTP_FROM_NAME || "Transform Solutions";

const smtpPort = Number(SMTP_PORT) || 587;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.error(
    "[Email] SMTP_HOST / SMTP_USER / SMTP_PASS is missing. QC notification emails will not send.",
  );
} else {
  console.log(`[Email] SMTP configured: ${SMTP_HOST}:${smtpPort} as ${SMTP_USER}`);
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  requireTLS: smtpPort === 587,
  auth:
    SMTP_USER && SMTP_PASS
      ? {
          user: SMTP_USER,
          pass: SMTP_PASS,
        }
      : undefined,
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 15000,
  greetingTimeout: 15000,
  socketTimeout: 20000,
});

if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter.verify().then(
    () => console.log("[Email] SMTP connection verified."),
    (err) => console.error("[Email] SMTP verify failed. QC mails will not send:", err?.message || err),
  );
}

export default transporter;
