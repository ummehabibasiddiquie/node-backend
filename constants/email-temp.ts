interface ReworkEmailData {
  status?: string;
  project_name?: string;
  task_name?: string;
  qc_agent_name?: string;
  qc_score?: number | string;
  error_count?: number;
  error_list?: any[] | any;
  message?: string;
  file_path?: string;
  submission_time?: string;
}

export const generateReworkEmailHtml = (data: ReworkEmailData): string => {
  const {
    status,
    project_name,
    task_name,
    qc_agent_name,
    qc_score,
    error_count,
    error_list,
    message,
    file_path,
    submission_time,
  } = data;

  const normalizedStatus = (status || "").toLowerCase();
  const isRework = normalizedStatus === "rework";
  const isCorrection = normalizedStatus === "correction";
  const isRegular = normalizedStatus === "regular";

  // Dynamic Theme Colors
  let headerColor = "#2563eb"; // Default Blue
  let boxBgColor = "#f1f5f9";
  let boxBorderColor = "#d1d5db";
  let accentColor = "#1f2937";
  let statusText = status || "Notification";

  if (isRework) {
    headerColor = "#dc2626"; // Red
    boxBgColor = "#fef2f2";
    boxBorderColor = "#fecaca";
    accentColor = "#991b1b";
    statusText = "🚨 URGENT: Rework Required";
  } else if (isCorrection) {
    headerColor = "#ea580c"; // Orange
    boxBgColor = "#fff7ed";
    boxBorderColor = "#fed7aa";
    accentColor = "#9a3412";
    statusText = "⚠️ ACTION REQUIRED: Correction";
  } else if (isRegular) {
    headerColor = "#059669"; // Green
    boxBgColor = "#f0fdf4";
    boxBorderColor = "#bbf7d0";
    accentColor = "#166534";
    statusText = "✅ QC Approved (Regular)";
  }

  const hasErrors =
    (error_count ?? 0) > 0 ||
    (error_list && Array.isArray(error_list) && error_list.length > 0);

  return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>QC Notification</title>
</head>
<body style="margin:0; padding:0; background-color:#f8fafc; font-family:Arial, Helvetica, sans-serif;">
 
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:#f8fafc;">
    <tr>
      <td align="center" style="padding:40px 15px;">
 
        <!-- Container -->
        <table width="600" cellpadding="0" cellspacing="0" role="presentation"
          style="background-color:#ffffff; border-radius:12px; border:1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);">
  
          <!-- Header -->
          <tr>
            <td align="center"
              style="background-color:${headerColor}; padding:32px 24px; border-radius:12px 12px 0 0;">
              <h2 style="margin:0; color:#ffffff; font-size:22px; letter-spacing: 0.5px;">
                ${statusText}
              </h2>
            </td>
          </tr>
 
          <!-- Body -->
          <tr>
            <td style="padding:32px; color:#334155; font-size:15px; line-height:1.6;">
 
              <p style="margin:0 0 16px; font-size:16px;">
                Hello,
              </p>
 
              <p style="margin:0 0 24px;">
                A Quality Control review has been completed for your recent submission. Please find the details below:
              </p>
 
              <!-- Summary Card -->
              <div style="background-color:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:20px; margin-bottom:24px;">
                <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse: collapse;">
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; color: #64748b; width: 35%;">Project Name</td>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #1e293b;">${project_name || "N/A"}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">Task Name</td>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #1e293b;">${task_name || "N/A"}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">QC Analyst</td>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #1e293b;">${qc_agent_name || "QA Department"}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">QC Score</td>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; font-weight: 700; color: ${isRegular ? "#059669" : "#2563eb"}; font-size: 18px;">${qc_score !== undefined ? qc_score : "N/A"}%</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; color: #64748b;">Submission Time</td>
                    <td style="padding: 8px 0; border-bottom: 1px solid #e2e8f0; font-weight: 600; color: #1e293b;">${submission_time || "N/A"}</td>
                  </tr>
                  <tr>
                    <td style="padding: 8px 0; color: #64748b;">File Path</td>
                    <td style="padding: 8px 0; font-weight: 600; color: #1e293b; word-break: break-all;">
                      <a href="${file_path}" style="color: #2563eb; text-decoration: none;">View Submitted File</a>
                    </td>
                  </tr>
                </table>
              </div>
 
              ${
                hasErrors
                  ? `
              <!-- Observations / Error Box -->
              <div style="background-color:${boxBgColor}; border:1px solid ${boxBorderColor}; border-radius:8px; padding:24px; margin-bottom:24px;">
                <h3 style="margin:0 0 12px; color:${accentColor}; font-size:16px; border-bottom: 1px solid ${boxBorderColor}; padding-bottom: 8px;">
                  Observations & Errors
                </h3>
                <p style="margin:0 0 12px; color:${accentColor}; font-size: 14px;">
                  <strong>Review Status:</strong> ${status}<br>
                  ${error_count !== undefined ? `<strong>Total Errors Identified:</strong> ${error_count}` : ""}
                </p>
                
                ${
                  error_list &&
                  Array.isArray(error_list) &&
                  error_list.length > 0
                    ? `
                <div style="margin-top:16px; overflow-x: auto;">
                  <table width="100%" cellpadding="10" cellspacing="0" style="border-collapse: collapse; font-size: 13px; color: ${accentColor}; background-color: #ffffff; border: 1px solid ${boxBorderColor};">
                    <thead>
                      <tr style="background-color: ${boxBorderColor}33;">
                        <th style="border: 1px solid ${boxBorderColor}; text-align: left;">QC Code</th>
                        <th style="border: 1px solid ${boxBorderColor}; text-align: left;">Category</th>
                        <th style="border: 1px solid ${boxBorderColor}; text-align: left;">Subcategory</th>
                        <th style="border: 1px solid ${boxBorderColor}; text-align: right;">Points</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${error_list
                        .map(
                          (err: any) => `
                        <tr>
                          <td style="border: 1px solid ${boxBorderColor}; text-align: left;">${err.qc_code || err.qcCode || "-"}</td>
                          <td style="border: 1px solid ${boxBorderColor}; text-align: left;">${err.category || "-"}</td>
                          <td style="border: 1px solid ${boxBorderColor}; text-align: left;">${err.subcategory || "-"}</td>
                          <td style="border: 1px solid ${boxBorderColor}; text-align: right;">${err.points || 0}</td>
                        </tr>
                      `,
                        )
                        .join("")}
                    </tbody>
                  </table>
                </div>
                `
                    : ""
                }
              </div>
              `
                  : ""
              }
 
              ${
                message
                  ? `
              <div style="margin-bottom:24px;">
                <strong style="display:block; margin-bottom:8px; color: #475569;">QA Comments:</strong>
                <div style="padding:20px; background-color:#f1f5f9; border-left:4px solid #94a3b8; color:#334155; font-style: italic;">
                  ${String(message).replace(/\n/g, "<br>")}
                </div>
              </div>
              `
                  : ""
              }
  
              <div style="padding:24px; background-color: #f8fafc; border-radius: 8px; text-align: center; border: 1px dashed #cbd5e1;">
                <p style="margin:0; font-weight: 600; color: ${accentColor};">
                  ${
                    isRework
                      ? "ACTION REQUIRED: Please rework and resubmit this file immediately."
                      : isCorrection
                        ? "ACTION REQUIRED: Please apply the corrections to the file."
                        : "Your submission has been accepted. Great work!"
                  }
                </p>
              </div>
 
              <p style="margin:32px 0 0; color:#64748b; font-size: 14px;">
                Best regards,<br />
                <strong style="color: #1e293b;">QA Team</strong>
              </p>
 
            </td>
          </tr>
 
          <!-- Footer -->
          <tr>
            <td align="center"
              style="background-color:#f1f5f9; padding:24px; border-radius:0 0 12px 12px;
              color:#94a3b8; font-size:12px;">
              This is an automated notification from the TFS Quality Assurance System.<br>
              © 2026 TRANSFORM Solutions. All rights reserved.
            </td>
          </tr>
 
        </table>
 
      </td>
    </tr>
  </table>
 
</body>
</html>`;
};
