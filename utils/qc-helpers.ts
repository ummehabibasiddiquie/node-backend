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

export function excelCellText(value: any): string {
  if (value == null || value === "") return "";
  if (typeof value !== "object") return String(value).trim();
  if ((value as any).text != null) return String((value as any).text).trim();
  if (Array.isArray((value as any).richText)) {
    return (value as any).richText.map((part: any) => part?.text || "").join("").trim();
  }
  if ((value as any).result != null) return String((value as any).result).trim();
  if ((value as any).hyperlink) return String((value as any).hyperlink).trim();
  return "";
}

function normalizeHeaderName(name: any): string {
  return excelCellText(name).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function isQcCodeHeader(name: any): boolean {
  const n = normalizeHeaderName(name);
  if (!n) return false;
  if (n === "qc code" || n === "qccode") return true;
  return n.includes("qc") && n.includes("code");
}

function normalizeQcCode(value: any): string {
  return excelCellText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function errorQcCode(err: any): string {
  if (!err || typeof err !== "object") return "";
  return normalizeQcCode(err.qc_code || err.qcCode || err.QC_Code);
}

function findQcCodeColumn(header: ExcelJS.Row): number | null {
  let found: number | null = null;
  header.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (found != null) return;
    if (isQcCodeHeader(cell.value)) found = colNumber;
  });
  return found;
}

function sheetLastDataRow(sheet: ExcelJS.Worksheet): number {
  let lastDataRow = 1;
  let hitSummary = false;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.number === 1) return;
    const first = excelCellText(row.getCell(1).value).toLowerCase();
    if (first === "error list") {
      hitSummary = true;
      return;
    }
    if (hitSummary) return;
    if (row.number > lastDataRow) lastDataRow = row.number;
  });
  return lastDataRow;
}

export function errorsNeedQcCodeBackfill(errorList: any): boolean {
  return parseQcErrorList(errorList).some(
    (err) => err && typeof err === "object" && !errorQcCode(err)
  );
}

/** Fill qc_code on legacy errors using the sample sheet (row 1 = first image). */
export function attachQcCodesToErrorList(
  sheet: ExcelJS.Worksheet,
  errorList: any
): any[] {
  const errors = parseQcErrorList(errorList).map((err) =>
    err && typeof err === "object" ? { ...err } : err
  );
  const qcCol = findQcCodeColumn(sheet.getRow(1));
  if (!qcCol) return errors;

  const lastDataRow = sheetLastDataRow(sheet);
  const displayByRow = new Map<number, string>();
  for (let r = 2; r <= lastDataRow; r++) {
    const raw = excelCellText(sheet.getRow(r).getCell(qcCol).value);
    if (raw) displayByRow.set(r, raw);
  }
  const dataRows = [...displayByRow.keys()].sort((a, b) => a - b);
  if (dataRows.length === 0) return errors;

  const onlyCode = dataRows.length === 1 ? displayByRow.get(dataRows[0]) : "";

  errors.forEach((err) => {
    if (!err || typeof err !== "object" || errorQcCode(err)) return;
    if (onlyCode) {
      err.qc_code = onlyCode;
      return;
    }
    const rowNum = Number(err.row);
    if (!Number.isFinite(rowNum)) return;
    const mapped = displayByRow.get(rowNum + 1) || displayByRow.get(rowNum);
    if (mapped) err.qc_code = mapped;
  });
  return errors;
}

/**
 * Adds an Errors column, highlights rows that have QC errors, and
 * appends the unique error list at the bottom of that column.
 * Prefers matching QC Code so one image is never marked as two Excel rows.
 */
export function annotateWorksheetWithQcErrors(
  sheet: ExcelJS.Worksheet,
  errorList: any
): void {
  const errors = attachQcCodesToErrorList(sheet, errorList);
  const header = sheet.getRow(1);
  let lastCol = 1;
  let existingErrorCol: number | null = null;
  header.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber > lastCol) lastCol = colNumber;
    const text = excelCellText(cell.value).toLowerCase();
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

  const qcCol = findQcCodeColumn(header);
  let lastDataRow = 1;
  let hitSummary = false;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.number === 1) return;
    const val = excelCellText(row.getCell(errorCol).value).toLowerCase();
    if (val === "error list") {
      hitSummary = true;
      return;
    }
    if (hitSummary) return;
    if (row.number > lastDataRow) lastDataRow = row.number;
  });

  const codeToExcelRows = new Map<string, number[]>();
  if (qcCol) {
    for (let r = 2; r <= lastDataRow; r++) {
      const code = normalizeQcCode(sheet.getRow(r).getCell(qcCol).value);
      if (!code) continue;
      const list = codeToExcelRows.get(code) || [];
      list.push(r);
      codeToExcelRows.set(code, list);
    }
  }

  const byRow = new Map<number, string[]>();
  const uniqueCounts = new Map<string, number>();
  errors.forEach((err) => {
    const label = qcErrorLabel(err).trim();
    if (!label) return;
    uniqueCounts.set(label, (uniqueCounts.get(label) || 0) + 1);

    const code = errorQcCode(err);
    let excelRows: number[] = code ? codeToExcelRows.get(code) || [] : [];
    if (excelRows.length === 0) {
      const rowNum = Number(err?.row);
      if (Number.isFinite(rowNum) && rowNum >= 2) excelRows = [rowNum];
    }

    excelRows.forEach((excelRow) => {
      if (excelRow < 2) return;
      const list = byRow.get(excelRow) || [];
      if (!list.includes(label)) list.push(label);
      byRow.set(excelRow, list);
    });
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

function sqlId(value: any): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowEmail(row: any): string {
  return String(row?.user_email || row?.email || "").trim();
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
    const agentId = sqlId(agent_id);
    const projectId = sqlId(project_id);
    const taskId = sqlId(task_id);
    const qaId = sqlId(qa_user_id);
    const trackerId = sqlId(tracker_id);
    console.log(
      `[QC Helper] Fetching email details for agent_id: ${agentId}, tracker_id: ${trackerId}`,
    );

    let agentName: string | null = null;
    let agentEmail = "";

    if (agentId != null) {
      const [agentRows]: any = await connection.execute(
        "SELECT user_name, user_email FROM tfs_user WHERE user_id = ?",
        [agentId]
      );
      agentName = agentRows[0]?.user_name || null;
      agentEmail = rowEmail(agentRows[0]);
    }

    if (!agentEmail && trackerId != null) {
      const [trackerRows]: any = await connection.execute(
        `SELECT u.user_name, u.user_email
         FROM task_work_tracker t
         INNER JOIN tfs_user u ON u.user_id = t.user_id
         WHERE t.tracker_id = ?
         LIMIT 1`,
        [trackerId]
      );
      if (trackerRows.length > 0) {
        agentName = agentName || trackerRows[0].user_name;
        agentEmail = rowEmail(trackerRows[0]);
        console.log(
          `[QC Helper] Agent email resolved from tracker ${trackerId}: ${agentEmail || "(empty)"}`,
        );
      }
    }

    if (!agentEmail && agentName) {
      const [nameRows]: any = await connection.execute(
        `SELECT user_email FROM tfs_user
         WHERE user_name = ? AND user_email IS NOT NULL AND TRIM(user_email) != ''
         LIMIT 1`,
        [agentName]
      );
      agentEmail = rowEmail(nameRows[0]);
      if (agentEmail) {
        console.log(`[QC Helper] Agent email resolved by name "${agentName}": ${agentEmail}`);
      }
    }

    let projectName = "N/A";
    let taskName = "N/A";
    let qaName = "QA Department";

    if (projectId != null) {
      const [projectRows]: any = await connection.execute(
        "SELECT project_name FROM project WHERE project_id = ?",
        [projectId]
      );
      projectName = projectRows[0]?.project_name || "N/A";
    }
    if (taskId != null) {
      const [taskRows]: any = await connection.execute(
        "SELECT task_name FROM task WHERE task_id = ?",
        [taskId]
      );
      taskName = taskRows[0]?.task_name || "N/A";
    }
    if (qaId != null) {
      const [qaRows]: any = await connection.execute(
        "SELECT user_name FROM tfs_user WHERE user_id = ?",
        [qaId]
      );
      qaName = qaRows[0]?.user_name || "QA Department";
    }

    if (!agentEmail) {
      console.error(
        `[QC Helper] No agent email found (agent_id=${agentId}, tracker_id=${trackerId})`,
      );
      return null;
    }

    return {
      agent_email: agentEmail,
      agent_name: agentName || "Agent",
      project_name: projectName,
      task_name: taskName,
      qa_name: qaName,
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
