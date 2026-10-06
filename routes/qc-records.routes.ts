import { Router } from "express";
import multer from "multer";
import {
  generateCustomSample,
  downloadCustomSample,
  downloadAnnotatedQcFile,
  saveQCRecord,
  getQCRecords,
  getQCRecordById,
  updateQCRecord,
  deleteQCRecord,
  agentUploadCorrection,
} from "../controllers/qc-records.controller";

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
});

router.post("/qc-records/generate-sample", generateCustomSample);
router.get("/qc-records/download-sample/:tracker_id", downloadCustomSample);
router.get("/qc-records/download-annotated/:id", downloadAnnotatedQcFile);
router.post("/qc-records/save", saveQCRecord);
router.get("/qc-records/list", getQCRecords);
router.get("/qc-records/view/:id", getQCRecordById);
router.put("/qc-records/update/:id", updateQCRecord);
router.delete("/qc-records/delete/:id", deleteQCRecord);
router.post(
  "/qc-records/agent-upload",
  upload.single("file"),
  agentUploadCorrection
);

export default router;

