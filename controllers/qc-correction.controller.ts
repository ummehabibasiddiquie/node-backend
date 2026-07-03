import { Request, Response } from "express";
import { get_db_connection } from "../database/db";
import { QCWorkflowService } from "../services/qc-workflow.service";
import {
  getQCRecordEmailDetails,
  handleQCStatusTransitions,
  uploadSampleToCloudinary,
} from "../utils/qc-helpers";
import { sendQCEmailInternal } from "../controllers/mail.controller";

/**
 * Controller for handling Correction QC evaluations
 * This is for reviewing correction files submitted by agents
 */
export const saveCorrectionQC = async (req: Request, res: Response) => {
  console.log("[QC Correction] POST /save received.");
  const connection = await get_db_connection();

  try {
    await connection.beginTransaction();

    // Extract form data
    const {
      logged_in_user_id,
      tracker_id,
      assistant_manager_id,
      qa_user_id,
      agent_id,
      project_id,
      task_id,
      whole_file_path,
      qc_file_path,
      date_of_file_submission,
      qc_score,
      file_record_count,
      data_generated_count,
      qc_generated_count,
      qc_file_records,
      error_list,
      error_score,
      comments,
    } = req.body;

    const resolvedGeneratedCount =
      data_generated_count ?? qc_generated_count ?? 0;

    const uploadedQCFilePath =
      qc_file_records && whole_file_path
        ? await uploadSampleToCloudinary(
            qc_file_records,
            whole_file_path,
            Number(resolvedGeneratedCount) || 10,
            "hrms/qc_samples",
          )
        : null;

    // Validate required fields
    if (!logged_in_user_id || !tracker_id || !qa_user_id || !project_id || !task_id) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Check if QC record exists for this tracker
    const [existingRows]: any = await connection.execute(
      "SELECT id, qc_status FROM qc_records WHERE tracker_id = ?",
      [tracker_id]
    );

    let qcId: number;
    let originalQCStatus: string;

    if (existingRows.length === 0) {
      // Create initial QC record if none exists
      console.log(`[QC Correction] No existing record found for tracker_id: ${tracker_id}. Creating initial record.`);
      const [insertResult]: any = await connection.execute(
        `INSERT INTO qc_records (
          assistant_manager_id, qa_user_id, agent_id, project_id, task_id,
          whole_file_path, date_of_file_submission, qc_score, status, qc_status,
          file_record_count, qc_generated_count,
          error_list, qc_file_path, tracker_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          assistant_manager_id || null,
          qa_user_id || null,
          agent_id || null,
          project_id || null,
          task_id || null,
          whole_file_path || null,
          date_of_file_submission || null,
          qc_score || null, // Use actual qc_score from payload
          'correction',
          'pending',
          file_record_count || 0,
          Number(resolvedGeneratedCount) || 0,
          error_list ? JSON.stringify(error_list) : null,
          uploadedQCFilePath || qc_file_path || null,
          tracker_id || null,
        ]
      );
      qcId = insertResult.insertId;
      originalQCStatus = 'pending'; // Default status for new records
    } else {
      qcId = existingRows[0].id;
      originalQCStatus = existingRows[0].qc_status;
    }

    // Handle correction workflow
    const finalQCStatus = await QCWorkflowService.handleCorrectionWorkflow(
      connection,
      qcId,
      "correction",
      {
        whole_file_path: whole_file_path || null,
        qc_file_path: uploadedQCFilePath || qc_file_path || null,
        error_list: error_list || [],
      },
    );

    // Run status-transition side-effects
    await handleQCStatusTransitions(
      connection,
      "correction",
      agent_id,
      project_id,
      task_id,
      "", // whole_file_path not needed for correction flow
      tracker_id,
      qcId
    );

    // Update the final status if it was changed by the workflow
    if (finalQCStatus !== originalQCStatus) {
      await connection.execute(
        "UPDATE qc_records SET qc_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [finalQCStatus, qcId],
      );
    }

    // Update qc_status in task_work_tracker
    if (tracker_id) {
      const updateTrackerStatusSql = `
        UPDATE task_work_tracker 
        SET qc_status = 1 
        WHERE tracker_id = ?
      `;
      await connection.execute(updateTrackerStatusSql, [tracker_id]);
      console.log(
        `[QC Correction] Updated qc_status to 1 for tracker_id: ${tracker_id}`,
      );
    }

    await connection.commit();

    // Send Background Email (Async)
    const emailData = await getQCRecordEmailDetails(
      connection,
      agent_id,
      project_id,
      task_id,
      qa_user_id,
    );

    if (emailData) {
      const submission_time = date_of_file_submission
        ? new Date(date_of_file_submission).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "N/A";

      // Fetch QC score and sample file path from correction history
      const [correctionHistoryRows]: any = await connection.execute(
        "SELECT qc_file_path, created_at FROM qc_correction_history WHERE qc_record_id = ? ORDER BY correction_count DESC LIMIT 1",
        [qcId]
      );
      const sampleFilePath = correctionHistoryRows.length > 0 ? correctionHistoryRows[0].qc_file_path : null;
      const correctionCreatedAt = correctionHistoryRows.length > 0 ? correctionHistoryRows[0].created_at : null;

      const [qcRecordRows]: any = await connection.execute(
        "SELECT qc_score FROM qc_records WHERE id = ?",
        [qcId]
      );
      const qcScore = qcRecordRows.length > 0 ? qcRecordRows[0].qc_score : null;

      // Use correction creation date if original submission date is not available
      const final_submission_time = date_of_file_submission
        ? new Date(date_of_file_submission).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : correctionCreatedAt
        ? new Date(correctionCreatedAt).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "N/A";

      sendQCEmailInternal({
        agent_email: emailData.agent_email,
        status: "correction",
        project_name: emailData.project_name,
        task_name: emailData.task_name,
        qc_agent_name: emailData.qa_name,
        qc_score: qcScore, // Fetch QC score from qc_records table
        error_count: error_list?.length || 0,
        error_list,
        comments: comments || "",
        file_path: sampleFilePath, // Fetch sample file from correction history
        submission_time: final_submission_time,
      }).catch((err: any) =>
        console.error("[QC Correction] Asynchronous email failed:", err),
      );
    }

    return res.status(200).json({
      success: true,
      message: "Correction QC record saved successfully",
      data: { id: qcId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error saving correction QC record:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) await connection.end();
  }
};

export const getCorrectionQCRecords = async (req: Request, res: Response) => {
  const { logged_in_user_id } = req.query;
  const connection = await get_db_connection();

  try {
    let sql = `
      SELECT 
        q.*,
        a.user_name as agent_name,
        qa.user_name as qa_name,
        am.user_name as am_name,
        p.project_name,
        t.task_name,
        ch.correction_count,
        ch.correction_status,
        ch.correction_file_path,
        ch.correction_file_qc_status
      FROM qc_records q
      LEFT JOIN tfs_user a ON q.agent_id = a.user_id
      LEFT JOIN tfs_user qa ON q.qa_user_id = qa.user_id
      LEFT JOIN tfs_user am ON q.assistant_manager_id = am.user_id
      LEFT JOIN project p ON q.project_id = p.project_id
      LEFT JOIN task t ON q.task_id = t.task_id
      LEFT JOIN qc_correction_history ch ON q.id = ch.qc_record_id
      WHERE q.status = 'correction'
    `;

    const queryParams: any[] = [];

    if (logged_in_user_id) {
      sql += ` AND q.agent_id = ?`;
      queryParams.push(logged_in_user_id);
    }

    sql += ` ORDER BY q.created_at DESC`;

    const [rows] = await connection.execute(sql, queryParams);
    return res.status(200).json({ success: true, data: rows });
  } catch (error) {
    console.error("Error fetching correction QC records:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  } finally {
    await connection.end();
  }
};
