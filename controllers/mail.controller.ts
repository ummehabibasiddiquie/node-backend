import { Request, Response } from "express";
import transporter, { accountEmail, fromName } from "../config/nodemailer";
import { generateReworkEmailHtml } from "../constants/email-temp";
import { get_db_connection } from "../database/db";
import { getQCRecordEmailDetails } from "../utils/qc-helpers";
import { SMTP_HOST, SMTP_USER, SMTP_PASS } from "../config/env";

interface QCEmailOptions {
  agent_email: string;
  subject?: string;
  message?: string;
  status?: string;
  [key: string]: any;
}

export const sendQCEmailInternal = async (options: QCEmailOptions) => {
  const { agent_email, subject, message, status, comments, ...templateData } = options;
  const finalMessage =
    typeof message === "string"
      ? message
      : comments == null
        ? ""
        : String(comments);
  console.log(`[Email Service] Starting email process for: ${agent_email} status=${status}`);

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)");
  }

  if (!agent_email) {
    console.error(`[Email Service] FAILED: No agent email provided`);
    throw new Error("agent_email is required");
  }

  let html: string;
  try {
    html = generateReworkEmailHtml({
      status,
      ...templateData,
      message: finalMessage || undefined,
    });
  } catch (err) {
    console.error("[Email Service] HTML template failed, sending text-only:", err);
    html = `<p>${finalMessage || `QC review completed with status: ${status}`}</p>`;
  }

  const mailOptions = {
    from: `"${fromName}" <${accountEmail}>`,
    to: agent_email,
    subject: subject || `QC Notification: ${status || "Update"}`,
    text: finalMessage || `QC review completed with status: ${status}`,
    html,
  };

  try {
    console.log(`[Email Service] Sending mail via SMTP...`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email Service] SUCCESS: Email sent to ${agent_email}. MessageID: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`[Email Service] FAILED to send email to ${agent_email}:`, error);
    throw error;
  }
};

function parseErrorList(error_list: any): any[] {
  if (!error_list) return [];
  if (Array.isArray(error_list)) return error_list;
  if (typeof error_list === "string") {
    try {
      const parsed = JSON.parse(error_list);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function formatSubmissionTime(value: any): string {
  if (!value) return "N/A";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export interface QcCompletionEmailPayload {
  agent_id?: number | null;
  project_id?: number | null;
  task_id?: number | null;
  qa_user_id?: number | null;
  tracker_id?: number | null;
  status: string;
  qc_score?: any;
  error_list?: any;
  comments?: any;
  file_path?: string | null;
  submission_time?: any;
}

/** Looks up the agent mailbox on a fresh connection so QC save can close its DB first. */
export function dispatchQcCompletionEmail(payload: QcCompletionEmailPayload): void {
  sendQcCompletionEmail(payload).catch((err: any) =>
    console.error("[QC Email] Asynchronous email failed:", err),
  );
}

async function sendQcCompletionEmail(payload: QcCompletionEmailPayload): Promise<void> {
  console.log(
    `[QC Email] Dispatch start status=${payload.status} agent_id=${payload.agent_id} tracker_id=${payload.tracker_id}`,
  );
  const connection = await get_db_connection();
  try {
    let agentId = payload.agent_id;
    let projectId = payload.project_id;
    let taskId = payload.task_id;
    const trackerId = payload.tracker_id;

    if ((!agentId || !projectId || !taskId) && trackerId != null && trackerId !== ("" as any)) {
      const [qcRows]: any = await connection.execute(
        "SELECT agent_id, project_id, task_id FROM qc_records WHERE tracker_id = ? LIMIT 1",
        [Number(trackerId)],
      );
      if (qcRows.length > 0) {
        agentId = agentId || qcRows[0].agent_id;
        projectId = projectId || qcRows[0].project_id;
        taskId = taskId || qcRows[0].task_id;
        console.log(
          `[QC Email] Filled missing ids from qc_records tracker=${trackerId} agent_id=${agentId}`,
        );
      }
    }

    const emailData = await getQCRecordEmailDetails(
      connection,
      agentId as number,
      projectId as number,
      taskId as number,
      payload.qa_user_id as number,
      trackerId,
    );

    if (!emailData?.agent_email) {
      console.error(
        `[QC Email] Skipped: no agent email (status=${payload.status}, agent_id=${agentId}, tracker_id=${trackerId})`,
      );
      return;
    }

    const errors = parseErrorList(payload.error_list);
    await sendQCEmailInternal({
      agent_email: emailData.agent_email,
      agent_name: emailData.agent_name,
      status: payload.status,
      project_name: emailData.project_name,
      task_name: emailData.task_name,
      qc_agent_name: emailData.qa_name,
      qc_score: payload.qc_score,
      error_count: errors.length,
      error_list: errors,
      comments: payload.comments || "",
      file_path: payload.file_path || undefined,
      submission_time: formatSubmissionTime(payload.submission_time),
    });
  } finally {
    await connection.end();
  }
}

export const sendReworkEmail = async (req: Request, res: Response) => {
  try {
    await sendQCEmailInternal(req.body);

    return res.status(200).json({
      success: true,
      message: "Email sent successfully to agent",
    });
  } catch (error) {
    console.error("Error sending QC email:", error);
    return res.status(error instanceof Error && error.message.includes("required") ? 400 : 500).json({
      success: false,
      message: error instanceof Error ? error.message : "Failed to send email",
    });
  }
};
