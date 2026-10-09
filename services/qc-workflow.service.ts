import { Connection } from "mysql2/promise";

/**
 * Service to handle specialized QC workflows for Correction, Rework, and Regular submissions.
 *
 * Lifecycle for Rework & Correction:
 *  1. QA marks status → INSERT new history row (file_path = NULL, file_qc_status = NULL)
 *  2. Agent uploads corrected file → same endpoint → UPDATE open row:
 *       file_path = agent_file, file_qc_status = 'pending' (awaiting QA review)
 *  3a. QA approves agent's file (status=regular) → UPDATE row:
 *       file_qc_status = 'completed', qc_score = score, status = 'completed'
 *       → qc_records.qc_status = 'completed'
 *  3b. QA rejects agent's file (status=rework/correction again) → UPDATE row:
 *       file_qc_status = 'completed', qc_score = score
 *       → INSERT new row with count+1, file_path = NULL
 *
 * Open-row detection:
 *  - rework_file_path IS NULL    → agent hasn't uploaded yet
 *  - correction_file_path IS NULL → agent hasn't uploaded yet
 */
export class QCWorkflowService {
  /**
   * Handles the workflow for Regular submissions (100% Score / Approved).
   * Finalizes any open Correction or Rework cycles.
   */
  static async handleRegularWorkflow(
    connection: Connection,
    qcId: number,
    status: string,
    currentQCStatus: string | null,
    data: {
      whole_file_path: string | null;
      qc_file_path: string | null;
      error_list: any[];
      file_record_count?: number;
      qc_generated_count?: number;
      qc_score?: string | number;
    }
  ): Promise<string> {
    if (currentQCStatus === "correction") {
      await this.handleCorrectionWorkflow(connection, qcId, "regular", data);
    } else if (currentQCStatus === "rework") {
      await this.handleReworkWorkflow(connection, qcId, "regular", data);
    }
    return "completed";
  }

  /**
   * Handles the iterative Correction lifecycle.
   *
   * - QA sends the SAMPLE file (qc_file_path) to the agent for correction.
   * - Agent corrects and re-uploads (typically one cycle).
   *
   * New DB columns used:
   *   correction_file_qc_status  VARCHAR(20):  NULL | 'pending' | 'completed'
   *   correction_qc_score        DECIMAL(5,2): score set when QA closes the cycle
   */
  static async handleCorrectionWorkflow(
    connection: Connection,
    qcId: number,
    submissionStatus: string,
    data: {
      whole_file_path: string | null;
      qc_file_path: string | null;
      error_list: any[];
      qc_score?: string | number;
      file_record_count?: number;
      qc_generated_count?: number;
    }
  ): Promise<string> {
    console.log(`[QC Workflow] Processing Correction Flow for QC ID: ${qcId}`);

    // ── 1. Find the current active cycle (Awaiting agent or Awaiting QA review) ──
    const [activeRows]: any = await connection.execute(
      `SELECT qc_correction_id, correction_count, correction_file_qc_status
       FROM qc_correction_history
       WHERE qc_record_id = ? AND (correction_file_qc_status IS NULL OR correction_file_qc_status = 'pending')
       ORDER BY correction_count DESC
       LIMIT 1`,
      [qcId]
    );

    let currentCount = 0;

    if (activeRows.length > 0) {
      const activeRow = activeRows[0];
      currentCount = activeRow.correction_count;

      console.log(`[QC Workflow] Updating results for Correction Cycle ${currentCount}`);

      // ── 2. Update the results of the check performed on this cycle ────────────
      await connection.execute(
        `UPDATE qc_correction_history
         SET correction_error_list     = ?,
             correction_status         = 'completed',
             correction_file_qc_status = 'completed'
         WHERE qc_correction_id = ?`,
        [JSON.stringify(data.error_list || []), activeRow.qc_correction_id]
      );
    } else {
      // No active row found (either first time marking correction, or history was purged)
      const [countRows]: any = await connection.execute(
        `SELECT MAX(correction_count) as max_count FROM qc_correction_history WHERE qc_record_id = ?`,
        [qcId]
      );
      currentCount = countRows[0].max_count || 0;
    }

    // ── 3. If the results mean another correction is needed, open a NEW cycle ────
    if (submissionStatus === "correction") {
      const nextCount = currentCount + 1;
      await connection.execute(
        `INSERT INTO qc_correction_history (
           qc_record_id,
           qc_file_path,
           correction_file_path,
           correction_file_qc_status,
           correction_count,
           correction_status,
           correction_error_list
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          qcId,
          data.qc_file_path || null, // For correction, we send the sample/marked file to agent
          null, // correction_file_path (will be updated when agent uploads)
          null, // correction_file_qc_status (will be updated when agent uploads)
          nextCount,
          'correction',
          null // correction_error_list (will be updated when QA reviews)
        ]
      );


      console.log(
        `[QC Workflow] Correction (Cycle ${nextCount}): New placeholder started. Awaiting agent upload.`
      );
      return "correction";
    }

    return "completed";
  }

  /**
   * Handles the iterative Rework lifecycle.
   *
   * - QA sends the WHOLE file (whole_file_path) to the agent for rework.
   * - Agent reworks and re-uploads; multiple cycles are possible.
   *
   * New DB column used:
   *   rework_file_qc_status  VARCHAR(20):  NULL | 'pending' | 'completed'
   *   rework_qc_score        already exists — now populated per cycle
   */
  static async handleReworkWorkflow(
    connection: Connection,
    qcId: number,
    submissionStatus: string,
    data: {
      whole_file_path: string | null;
      qc_file_path: string | null;
      error_list: any[];
      file_record_count?: number;
      qc_generated_count?: number;
      qc_score?: string | number;
    }
  ): Promise<string> {
    console.log(`[QC Workflow] Processing Rework Flow for QC ID: ${qcId}`);

    // ── 1. Find the current active cycle (Awaiting agent or Awaiting QA review) ──
    const [activeRows]: any = await connection.execute(
      `SELECT qc_rework_id, rework_count, rework_file_qc_status
       FROM qc_rework_history
       WHERE qc_record_id = ? AND (rework_file_qc_status IS NULL OR rework_file_qc_status = 'pending')
       ORDER BY rework_count DESC
       LIMIT 1`,
      [qcId]
    );

    let currentCount = 0;

    if (activeRows.length > 0) {
      const activeRow = activeRows[0];
      currentCount = activeRow.rework_count;

      console.log(`[QC Workflow] Updating results for Rework Cycle ${currentCount}`);

      // ── 2. Update the results of the check performed on this cycle ────────────
      await connection.execute(
        `UPDATE qc_rework_history
         SET rework_error_list      = ?,
             rework_qc_score         = ?,
             file_record_count       = ?,
             qc_data_generated_count = ?,
             rework_status           = ?,
             rework_file_qc_status   = 'completed',
             updated_at              = CURRENT_TIMESTAMP
         WHERE qc_rework_id = ?`,
        [
          JSON.stringify(data.error_list),
          data.qc_score ?? null,
          data.file_record_count || 0,
          data.qc_generated_count || 0,
          submissionStatus === "regular" ? "completed" : "rework",
          activeRow.qc_rework_id,
        ]
      );
    } else {
      // No active row found (either first time marking rework, or history was purged)
      const [countRows]: any = await connection.execute(
        `SELECT MAX(rework_count) as max_count FROM qc_rework_history WHERE qc_record_id = ?`,
        [qcId]
      );
      currentCount = countRows[0].max_count || 0;
    }

    // ── 3. If the results mean another rework is needed, open a NEW cycle ───────
    if (submissionStatus === "rework") {
      const nextCount = currentCount + 1;
      await connection.execute(
        `INSERT INTO qc_rework_history (
           qc_record_id,
           qc_file_path,
           rework_file_path,
           rework_count,
           rework_status,
           rework_error_list,
           file_record_count,
           qc_data_generated_count,
           rework_qc_score,
           rework_file_qc_status,
           rework_sample_file
         ) VALUES (?, ?, NULL, ?, 'rework', NULL, NULL, NULL, NULL, NULL, ?)`,
        [
          qcId,
          data.whole_file_path, // The file the agent needs to fix next
          nextCount,
          data.qc_file_path,     // The markup/sample QA just generated
        ]
      );

      console.log(
        `[QC Workflow] Rework (Cycle ${nextCount}): New placeholder started. Awaiting agent upload.`
      );
      return "rework";
    }

    return "completed";
  }

  /**
   * Records an agent's file upload for an existing Rework or Correction cycle.
   * Updates the 'open' row (where file_path is NULL) with the new file URL.
   */
  static async recordAgentUpload(
    connection: Connection,
    qcId: number,
    type: "rework" | "correction",
    fileUrl: string
  ): Promise<void> {
    console.log(`[QC Workflow] Recording Agent Upload for QC ID: ${qcId}, Type: ${type}`);

    if (type === "rework") {
      // 1. Find the open rework row
      const [openRows]: any = await connection.execute(
        `SELECT qc_rework_id FROM qc_rework_history 
         WHERE qc_record_id = ? AND rework_file_path IS NULL 
         ORDER BY rework_count DESC LIMIT 1`,
        [qcId]
      );

      if (openRows.length === 0) {
        throw new Error("No open rework cycle found for this record.");
      }

      // 2. Update the row
      await connection.execute(
        `UPDATE qc_rework_history 
         SET rework_file_path = ?, rework_status = 'rework', rework_file_qc_status = 'pending'
         WHERE qc_rework_id = ?`,
        [fileUrl, openRows[0].qc_rework_id]
      );
    } else {
      // 1. Find the open correction row
      const [openRows]: any = await connection.execute(
        `SELECT qc_correction_id FROM qc_correction_history 
         WHERE qc_record_id = ? AND correction_file_path IS NULL 
         ORDER BY correction_count DESC LIMIT 1`,
        [qcId]
      );

      if (openRows.length === 0) {
        throw new Error("No open correction cycle found for this record.");
      }

      // 2. Update the row
      await connection.execute(
        `UPDATE qc_correction_history 
         SET correction_file_path = ?, correction_status = 'correction', correction_file_qc_status = 'pending'
         WHERE qc_correction_id = ?`,
        [fileUrl, openRows[0].qc_correction_id]
      );
    }

    // 3. Update the main record status to 'pending' so QA knows to review again
    await connection.execute(
      "UPDATE qc_records SET qc_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [qcId]
    );
  }
}
