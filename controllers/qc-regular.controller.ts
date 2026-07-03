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
 * Controller for handling Regular QC evaluations
 * This is for first-time QC evaluations of submitted files
 */
export const saveRegularQC = async (req: Request, res: Response) => {
  console.log("[QC Regular] POST /save received.");
  const connection = await get_db_connection();

  try {
    await connection.beginTransaction();

    // Extract form data with null checks
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

    // Backward/forward compatibility:
    // - older code used `data_generated_count`
    // - newer frontend sends `qc_generated_count`
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

    // Ensure all values are properly handled (undefined -> null)
    const safeParams = {
      assistant_manager_id: assistant_manager_id || null,
      qa_user_id: qa_user_id || null,
      agent_id: agent_id || null,
      project_id: project_id || null,
      task_id: task_id || null,
      whole_file_path: whole_file_path || null,
      qc_file_path: uploadedQCFilePath || qc_file_path || null,
      date_of_file_submission: date_of_file_submission || null,
      qc_score: qc_score || null,
      file_record_count: file_record_count || 0,
      data_generated_count: Number(resolvedGeneratedCount) || 0,
      error_list: error_list ? JSON.stringify(error_list) : null,
      tracker_id: tracker_id || null,
    };

    // Validate required fields
    if (!safeParams.qa_user_id || !safeParams.project_id || !safeParams.task_id || !safeParams.tracker_id) {
      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Check if QC record already exists for this tracker
    const [existingRows]: any = await connection.execute(
      "SELECT id, qc_status FROM qc_records WHERE tracker_id = ?",
      [safeParams.tracker_id]
    );

    if (existingRows.length > 0) {
      // Check if there's an active rework cycle for this record
      const [activeReworkRows]: any = await connection.execute(
        `SELECT qc_rework_id, rework_count FROM qc_rework_history
         WHERE qc_record_id = ? AND (rework_file_qc_status IS NULL OR rework_file_qc_status = 'pending')
         ORDER BY rework_count DESC LIMIT 1`,
        [existingRows[0].id]
      );

      if (activeReworkRows.length > 0) {
        // This is a rework evaluation - update rework_history instead of qc_records
        console.log(`[QC Regular] Regular submission for active rework cycle ${activeReworkRows[0].rework_count}`);
        const finalQCStatus = await QCWorkflowService.handleReworkWorkflow(
          connection,
          existingRows[0].id,
          "regular",
          {
            whole_file_path: safeParams.whole_file_path,
            qc_file_path: safeParams.qc_file_path,
            error_list: safeParams.error_list ? JSON.parse(safeParams.error_list) : [],
            file_record_count: safeParams.file_record_count,
            qc_generated_count: safeParams.data_generated_count,
            qc_score: safeParams.qc_score,
          },
        );

        // Run status-transition side-effects
        await handleQCStatusTransitions(
          connection,
          "regular",
          safeParams.agent_id,
          safeParams.project_id,
          safeParams.task_id,
          safeParams.tracker_id,
          existingRows[0].id,
          safeParams.whole_file_path
        );

        // Update the final status if it was changed by the workflow
        if (finalQCStatus !== existingRows[0].qc_status) {
          await connection.execute(
            "UPDATE qc_records SET qc_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [finalQCStatus, existingRows[0].id],
          );
        }

        // Update qc_status in task_work_tracker
        if (safeParams.tracker_id) {
          const updateTrackerStatusSql = `
            UPDATE task_work_tracker 
            SET qc_status = 1 
            WHERE tracker_id = ?
          `;
          await connection.execute(updateTrackerStatusSql, [safeParams.tracker_id]);
          console.log(
            `[QC Regular] Updated qc_status to 1 for tracker_id: ${safeParams.tracker_id}`,
          );
        }

        await connection.commit();

        // Send Background Email (Async)
        const emailData = await getQCRecordEmailDetails(
          connection,
          safeParams.agent_id,
          safeParams.project_id,
          safeParams.task_id,
          safeParams.qa_user_id,
        );

        if (emailData) {
          const submission_time = safeParams.date_of_file_submission
            ? new Date(safeParams.date_of_file_submission).toLocaleDateString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })
            : "N/A";

          sendQCEmailInternal({
            agent_email: emailData.agent_email,
            status: "regular",
            project_name: emailData.project_name,
            task_name: emailData.task_name,
            qc_agent_name: emailData.qa_name,
            qc_score: safeParams.qc_score,
            error_count: safeParams.error_list ? JSON.parse(safeParams.error_list).length || 0 : 0,
            error_list: safeParams.error_list ? JSON.parse(safeParams.error_list) : [],
            comments: "",
            file_path: safeParams.qc_file_path,
            submission_time,
          }).catch((err: any) =>
            console.error("[QC Regular] Asynchronous email failed:", err),
          );
        }

        return res.status(200).json({
          success: true,
          message: "Rework QC record saved successfully",
          data: { id: existingRows[0].id },
        });
      }

      // Check if there's an active correction cycle for this record
      const [activeCorrectionRows]: any = await connection.execute(
        `SELECT qc_correction_id, correction_count FROM qc_correction_history
         WHERE qc_record_id = ? AND (correction_file_qc_status IS NULL OR correction_file_qc_status = 'pending')
         ORDER BY correction_count DESC LIMIT 1`,
        [existingRows[0].id]
      );

      if (activeCorrectionRows.length > 0) {
        // This is a correction evaluation - update correction_history instead of qc_records
        console.log(`[QC Regular] Regular submission for active correction cycle ${activeCorrectionRows[0].correction_count}`);
        const finalQCStatus = await QCWorkflowService.handleCorrectionWorkflow(
          connection,
          existingRows[0].id,
          "regular",
          {
            qc_file_path: safeParams.qc_file_path,
            whole_file_path: safeParams.whole_file_path,
            error_list: safeParams.error_list ? JSON.parse(safeParams.error_list) : [],
            // no qc_score — correction is status-only
          },
        );

        // Run status-transition side-effects
        await handleQCStatusTransitions(
          connection,
          "regular",
          safeParams.agent_id,
          safeParams.project_id,
          safeParams.task_id,
          safeParams.tracker_id,
          existingRows[0].id,
          safeParams.whole_file_path
        );

        // Update the final status if it was changed by the workflow
        if (finalQCStatus !== existingRows[0].qc_status) {
          await connection.execute(
            "UPDATE qc_records SET qc_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            [finalQCStatus, existingRows[0].id],
          );
        }

        // Update qc_status in task_work_tracker
        if (safeParams.tracker_id) {
          const updateTrackerStatusSql = `
            UPDATE task_work_tracker 
            SET qc_status = 1 
            WHERE tracker_id = ?
          `;
          await connection.execute(updateTrackerStatusSql, [safeParams.tracker_id]);
          console.log(
            `[QC Regular] Updated qc_status to 1 for tracker_id: ${safeParams.tracker_id}`,
          );
        }

        await connection.commit();

        // Send Background Email (Async)
        const emailData = await getQCRecordEmailDetails(
          connection,
          safeParams.agent_id,
          safeParams.project_id,
          safeParams.task_id,
          safeParams.qa_user_id,
        );

        if (emailData) {
          // Fetch QC score and sample file path from correction history
          const [correctionHistoryRows]: any = await connection.execute(
            "SELECT qc_file_path, created_at FROM qc_correction_history WHERE qc_record_id = ? ORDER BY correction_count DESC LIMIT 1",
            [existingRows[0].id]
          );
          const sampleFilePath = correctionHistoryRows.length > 0 ? correctionHistoryRows[0].qc_file_path : null;
          const correctionCreatedAt = correctionHistoryRows.length > 0 ? correctionHistoryRows[0].created_at : null;

          const [qcRecordRows]: any = await connection.execute(
            "SELECT qc_score FROM qc_records WHERE id = ?",
            [existingRows[0].id]
          );
          const qcScore = qcRecordRows.length > 0 ? qcRecordRows[0].qc_score : null;

          // Use correction creation date if original submission date is not available
          const final_submission_time = safeParams.date_of_file_submission
            ? new Date(safeParams.date_of_file_submission).toLocaleDateString("en-IN", {
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
            agent_name: emailData.agent_name,
            agent_email: emailData.agent_email,
            project_name: emailData.project_name,
            task_name: emailData.task_name,
            qa_name: emailData.qa_name,
            status: "correction", // Specify this is a correction completion
            qc_score: qcScore, // Fetch QC score from qc_records table
            file_path: sampleFilePath, // Fetch sample file from correction history
            submission_time: final_submission_time,
          }).catch((err: any) =>
            console.error("[QC Regular] Asynchronous email failed:", err),
          );
        }

        return res.status(200).json({
          success: true,
          message: "Correction QC record saved successfully",
          data: { id: existingRows[0].id },
        });
      }

      await connection.rollback();
      return res.status(400).json({
        success: false,
        message: "QC record already exists for this tracker. Use rework or correction endpoints instead.",
      });
    }

    // Insert new QC record
    const [insertResult]: any = await connection.execute(
      `INSERT INTO qc_records (
        assistant_manager_id, qa_user_id, agent_id, project_id, task_id,
        whole_file_path, date_of_file_submission, qc_score, status, qc_status,
        file_record_count, qc_generated_count,
        error_list, qc_file_path, tracker_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        safeParams.assistant_manager_id,
        safeParams.qa_user_id,
        safeParams.agent_id,
        safeParams.project_id,
        safeParams.task_id,
        safeParams.whole_file_path,
        safeParams.date_of_file_submission,
        safeParams.qc_score,
        'regular',
        'completed',
        safeParams.file_record_count,
        safeParams.data_generated_count,
        safeParams.error_list,
        safeParams.qc_file_path,
        safeParams.tracker_id,
      ]
    );

    const qcId = insertResult.insertId;
    console.log(`[QC Regular] New QC record created with ID: ${qcId}`);

    // Handle workflow (should be completed for regular QC)
    const finalQCStatus = await QCWorkflowService.handleRegularWorkflow(
      connection,
      qcId,
      "regular",
      null,
      {
        whole_file_path: safeParams.whole_file_path,
        qc_file_path: safeParams.qc_file_path,
        error_list: safeParams.error_list ? JSON.parse(safeParams.error_list) : [],
        file_record_count: safeParams.file_record_count,
        qc_generated_count: safeParams.data_generated_count,
        qc_score: safeParams.qc_score,
      },
    );

    // Run status-transition side-effects
    await handleQCStatusTransitions(
      connection,
      "regular",
      safeParams.agent_id,
      safeParams.project_id,
      safeParams.task_id,
      safeParams.whole_file_path,
      safeParams.tracker_id,
      qcId,
    );

    // Update qc_status in task_work_tracker
    if (safeParams.tracker_id) {
      const updateTrackerStatusSql = `
        UPDATE task_work_tracker 
        SET qc_status = 1 
        WHERE tracker_id = ?
      `;
      await connection.execute(updateTrackerStatusSql, [safeParams.tracker_id]);
      console.log(
        `[QC Regular] Updated qc_status to 1 for tracker_id: ${safeParams.tracker_id}`,
      );
    }

    await connection.commit();

    // Send Background Email (Async)
    const emailData = await getQCRecordEmailDetails(
      connection,
      safeParams.agent_id,
      safeParams.project_id,
      safeParams.task_id,
      safeParams.qa_user_id,
    );

    if (emailData) {
      const submission_time = safeParams.date_of_file_submission
        ? new Date(safeParams.date_of_file_submission).toLocaleDateString("en-IN", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "N/A";

      sendQCEmailInternal({
        agent_email: emailData.agent_email,
        status: "regular",
        project_name: emailData.project_name,
        task_name: emailData.task_name,
        qc_agent_name: emailData.qa_name,
        qc_score: safeParams.qc_score,
        error_count: safeParams.error_list ? JSON.parse(safeParams.error_list).length || 0 : 0,
        error_list: safeParams.error_list ? JSON.parse(safeParams.error_list) : [],
        comments: "",
        file_path: safeParams.qc_file_path,
        submission_time,
      }).catch((err: any) =>
        console.error("[QC Regular] Asynchronous email failed:", err),
      );
    }

    return res.status(200).json({
      success: true,
      message: "Regular QC record saved successfully",
      data: { id: qcId },
    });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Error saving regular QC record:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  } finally {
    if (connection) await connection.end();
  }
};

export const getRegularQCRecords = async (req: Request, res: Response) => {
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
        t.task_name
      FROM qc_records q
      LEFT JOIN tfs_user a ON q.agent_id = a.user_id
      LEFT JOIN tfs_user qa ON q.qa_user_id = qa.user_id
      LEFT JOIN tfs_user am ON q.assistant_manager_id = am.user_id
      LEFT JOIN project p ON q.project_id = p.project_id
      LEFT JOIN task t ON q.task_id = t.task_id
      WHERE q.status = 'regular'
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
    console.error("Error fetching regular QC records:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  } finally {
    await connection.end();
  }
};
