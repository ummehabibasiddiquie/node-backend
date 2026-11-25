import { DB_DATABASE } from "../config/env";

const SUBJECT_PREFIX = "[VERCEL TEST]";
const BANNER_HTML =
  '<div style="background:#fff3cd;border:2px solid #f0ad4e;color:#7a4e00;' +
  "padding:12px 16px;margin:0 0 16px 0;font-family:Arial,sans-serif;font-size:14px;line-height:1.4;\">" +
  "<strong>VERCEL / TEST ENVIRONMENT</strong><br>" +
  "This message was sent while testing HRMS on Vercel against the test database " +
  "(mytfs_test). It is for testing only. Please ignore it for live work." +
  "</div>";
const BANNER_TEXT =
  "VERCEL / TEST ENVIRONMENT: This email is from HRMS testing on Vercel " +
  "(database mytfs_test). For testing only. Ignore for live work.\n\n";

export function isTestMailEnv(): boolean {
  const flag = String(process.env.MAIL_TEST_BANNER || "")
    .trim()
    .toLowerCase();
  if (["1", "true", "yes", "on"].includes(flag)) return true;
  if (["0", "false", "no", "off"].includes(flag)) return false;
  return String(DB_DATABASE || "")
    .trim()
    .toLowerCase() === "mytfs_test";
}

export function applyTestMailNotice(options: {
  subject?: string;
  html?: string;
  text?: string;
}): { subject: string; html?: string; text?: string } {
  if (!isTestMailEnv()) {
    return {
      subject: options.subject || "",
      html: options.html,
      text: options.text,
    };
  }
  let subject = options.subject || "";
  if (!subject.toUpperCase().startsWith(SUBJECT_PREFIX)) {
    subject = `${SUBJECT_PREFIX} ${subject}`.trim();
  }
  let html = options.html;
  if (html) {
    const lower = html.toLowerCase();
    const bodyAt = lower.indexOf("<body");
    if (bodyAt >= 0) {
      const gt = html.indexOf(">", bodyAt);
      html =
        gt >= 0
          ? html.slice(0, gt + 1) + BANNER_HTML + html.slice(gt + 1)
          : BANNER_HTML + html;
    } else {
      html = BANNER_HTML + html;
    }
  }
  const text =
    options.text !== undefined ? BANNER_TEXT + options.text : options.text;
  return { subject, html, text };
}
