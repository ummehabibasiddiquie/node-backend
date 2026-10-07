import { Connection } from "mysql2/promise";
import ExcelJS from "exceljs";
import path from "path";
import { uploadBufferToCloudinary } from "./cloudinary-utils";

/**
 * Formats a date string to include current time if only YYYY-MM-DD is provided.
 */
export function formatSubmissionDate(date_of_file_submission: any): string {
  let formattedDate = date_of_file_submission;
  if (typeof formattedDate === "string" && formattedDate.trim().length <= 10) {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    formattedDate = `${formattedDate.trim()} ${hh}:${mm}:${ss}`;
  }
  return formattedDate;
}

export function parseQcErrorList(raw: any): any[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function qcErrorLabel(error: any): string {
  if (error == null) return "";
  if (typeof error !== "object") return String(error);
  return (
    error.error ||
    (error.category && error.subcategory
      ? `${error.category} - ${error.subcategory}`
      : "") ||
    error.name ||
    error.message ||
    JSON.stringify(error)
  );
}

/**
 * Adds an Errors column, highlights rows that have QC errors, and
 * appends the unique error list at the bottom of that column.
 * `error.row` is 1-based sample-record index (Excel data starts at row 2).
 */
export function annotateWorksheetWithQcErrors(
  sheet: ExcelJS.Worksheet,
  errorList: any
): void {
  const errors = parseQcErrorList(errorList);
  const header = sheet.getRow(1);
  let lastCol = 1;
  let existingErrorCol: number | null = null;
  header.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber > lastCol) lastCol = colNumber;
    const text = String(cell.value || "").trim().toLowerCase();
    if (text === "errors") existingErrorCol = colNumber;
  });
  if (sheet.columnCount > lastCol) lastCol = sheet.columnCount;

  const errorCol = existingErrorCol || lastCol + 1;
  const headerCell = header.getCell(errorCol);
  headerCell.value = "Errors";
  headerCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFB91C1C" },
  };
  headerCell.alignment = { vertical: "middle", wrapText: true };
  sheet.getColumn(errorCol).width = 48;

  const byRow = new Map<number, string[]>();
  const uniqueCounts = new Map<string, number>();
  errors.forEach((err) => {
    const label = qcErrorLabel(err).trim();
    if (!label) return;
    uniqueCounts.set(label, (uniqueCounts.get(label) || 0) + 1);
    const rowNum = Number(err?.row);
    if (!Number.isFinite(rowNum) || rowNum < 1) return;
    // error.row matches the Excel row shown in View Error (header is row 1).
    const list = byRow.get(rowNum) || [];
    if (!list.includes(label)) list.push(label);
    byRow.set(rowNum, list);
  });

  let lastDataRow = 1;
  let hitSummary = false;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.number === 1) return;
    const val = String(row.getCell(errorCol).value || "").trim().toLowerCase();
    if (val === "error list") {
      hitSummary = true;
      return;
    }
    if (hitSummary) return;
    if (row.number > lastDataRow) lastDataRow = row.number;
  });

  byRow.forEach((labels, excelRow) => {
    const row = sheet.getRow(excelRow);
    const cell = row.getCell(errorCol);
    cell.value = labels.join("; ");
    cell.alignment = { wrapText: true, vertical: "top" };
    cell.font = { color: { argb: "FF9C0006" }, bold: true };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFC7CE" },
    };
    row.eachCell({ includeEmpty: true }, (dataCell, colNumber) => {
      if (colNumber === errorCol) return;
      if (!dataCell.fill || dataCell.fill.type !== "pattern") {
        dataCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFFFEBEE" },
        };
      }
    });
    if (excelRow > lastDataRow) lastDataRow = excelRow;
  });

  let next = lastDataRow + 2;
  const titleCell = sheet.getRow(next).getCell(errorCol);
  titleCell.value = "Error List";
  titleCell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFB91C1C" },
  };
  next += 1;

  if (uniqueCounts.size === 0) {
    sheet.getRow(next).getCell(errorCol).value = "No errors";
    return;
  }

  uniqueCounts.forEach((count, name) => {
    const cell = sheet.getRow(next).getCell(errorCol);
    cell.value = `${name} (${count})`;
    cell.font = { color: { argb: "FF9C0006" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFFF2CC" },
    };
    next += 1;
  });
}

/**
 * Generates an Excel buffer for sampled QC records and uploads it to Cloudinary.
 */
export async function uploadSampleToCloudinary(
  qc_file_records: any,
  whole_file_path: string | null,
  percentage: number = 10,
  folderName: string = "hrms/qc_samples",
  error_list: any = null
): Promise<string | null> {
  try {
    const sampleData = typeof qc_file_records === "string" ? JSON.parse(qc_file_records) : qc_file_records;

    if (Array.isArray(sampleData) && sampleData.length > 0) {
      const sampleWorkbook = new ExcelJS.Workbook();
      const sampleSheet = sampleWorkbook.addWorksheet(`QC Sample ${percentage}%`);

      const headers = Object.keys(sampleData[0]);
      sampleSheet.addRow(headers);

      sampleData.forEach((record: any) => {
        sampleSheet.addRow(headers.map((h) => record[h]));
      });

      if (error_list) {
        annotateWorksheetWithQcErrors(sampleSheet, error_list);
      }

      const buffer = (await sampleWorkbook.xlsx.writeBuffer()) as any;
      const fileName =
        path.basename(
          whole_file_path || "sample",
          path.extname(whole_file_path || ".xlsx")
        ) +
        `_${percentage}_sample_` +
        Date.now() +
        ".xlsx";

      const uploadRes = await uploadBufferToCloudinary(buffer, folderName, fileName);
      return uploadRes.secure_url;
    }
  } catch (err) {
    console.error("[QC Helper] Failed to upload sample to Cloudinary:", err);
  }
  return null;
}

/**
 * Fetches required details for email notification in a single batch of queries.
 */
export async function getQCRecordEmailDetails(
  connection: Connection,
  agent_id: number,
  project_id: number,
  task_id: number,
  qa_user_id: number,
  tracker_id?: number | null
): Promise<any> {
  try {
    console.log(
      `[QC Helper] Fetching email details for agent_id: ${agent_id}, tracker_id: ${tracker_id}`,
    );
    const [agentRows]: any = await connection.execute(
      "SELECT user_name, user_email FROM tfs_user WHERE user_id = ?",
      [agent_id]
    );
    let agentName = agentRows[0]?.user_name || null;
    let agentEmail = (agentRows[0]?.user_email || "").trim();

    if ((!agentEmail || agentRows.length === 0) && tracker_id) {
      const [trackerRows]: any = await connection.execute(
        `SELECT u.user_name, u.user_email
         FROM task_work_tracker t
         INNER JOIN tfs_user u ON u.user_id = t.user_id
         WHERE t.tracker_id = ?
         LIMIT 1`,
        [tracker_id]
      );
      if (trackerRows.length > 0) {
        agentName = agentName || trackerRows[0].user_name;
        agentEmail = agentEmail || (trackerRows[0].user_email || "").trim();
        console.log(
          `[QC Helper] Agent email resolved from tracker ${tracker_id}: ${agentEmail || "(empty)"}`,
        );
      }
    }

    const [projectRows]: any = await connection.execute(
      "SELECT project_name FROM project WHERE project_id = ?",
      [project_id]
    );
    const [taskRows]: any = await connection.execute(
      "SELECT task_name FROM task WHERE task_id = ?",
      [task_id]
    );
    const [qaRows]: any = await connection.execute(
      "SELECT user_name FROM tfs_user WHERE user_id = ?",
      [qa_user_id]
    );

    if (!agentEmail) {
      console.error(
        `[QC Helper] No agent email found (agent_id=${agent_id}, tracker_id=${tracker_id})`,
      );
      return null;
    }

    return {
      agent_email: agentEmail,
      agent_name: agentName || "Agent",
      project_name: projectRows[0]?.project_name || "N/A",
      task_name: taskRows[0]?.task_name || "N/A",
      qa_name: qaRows[0] ? qaRows[0].user_name : "QA Department",
    };
  } catch (err) {
    console.error("[QC Helper] Error fetching email details:", err);
  }
  return null;
}

/**
 * Handles database updates for status transitions (Rework/Correction).
 */
export async function handleQCStatusTransitions(
  connection: Connection,
  status: string,
  agent_id: number,
  project_id: number,
  task_id: number,
  whole_file_path: string,
  tracker_id: number | null,
  qcId: number
): Promise<void> {
  const normalizedStatus = (status || "").toLowerCase();
  
  // 1. Reset duplicate check scoped to this specific file
  const deleteTrackerRecordsSql = `
    DELETE FROM tracker_records 
    WHERE user_id = ? AND project_id = ? AND task_id = ? AND file_path = ?
  `;
  await connection.execute(deleteTrackerRecordsSql, [
    agent_id,
    project_id,
    task_id,
    whole_file_path,
  ]);
  console.log(`[QC Helper] Reset duplicate check: Deleted tracker_records for file: ${whole_file_path}`);

  // 2. Handle Rework Tracker Entry (Side-effects for history are now handled in QCWorkflowService)
  // No further legacy table updates needed.
}

/**
 * Samples records using systematic random sampling.
 * Selects every k-th record starting from a random index.
 */
export function generateSystematicSample<T>(records: T[], sampleSize: number): T[] {
  if (!records || records.length === 0 || sampleSize <= 0) {
    return [];
  }

  const totalRecords = records.length;
  if (sampleSize >= totalRecords) {
    return [...records]; // Return all if sample size exceeds total
  }

  const interval = totalRecords / sampleSize;
  const start = Math.floor(Math.random() * interval);
  const sampled: T[] = [];

  for (let i = 0; i < sampleSize; i++) {
    const index = Math.floor(start + i * interval);
    if (index < totalRecords) {
      sampled.push(records[index]);
    }
  }

  return sampled;
}
