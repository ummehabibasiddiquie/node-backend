import { config } from "dotenv";
import fs from "fs";
import path from "path";

// Production runs `node dist/index.js` so __dirname is dist/config (not project root).
// Fill in missing vars from the first .env that exists; do not override PM2/system env.
const envCandidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(__dirname, "..", ".env"),
  path.resolve(__dirname, "..", "..", ".env"),
];

let loadedEnvPath: string | null = null;
for (const envPath of envCandidates) {
  if (fs.existsSync(envPath)) {
    config({ path: envPath, override: false });
    loadedEnvPath = envPath;
    break;
  }
}

console.log(
  loadedEnvPath
    ? `[Config] Loaded .env from: ${loadedEnvPath}`
    : `[Config] No .env file found (checked: ${envCandidates.join(", ")})`,
);


export const {
  PORT,
  NODE_ENV,
  SERVER_URL,
  PYTHON_URL,
  PYTHON_URL_1,
  PYTHON_URL_2,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM_NAME,
  UPLOADS_DIR,
  DB_HOST,
  DB_PORT,
  DB_DATABASE,
  DB_USERNAME,
  DB_PASSWORD,
  CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET,
} = process.env;

// Support for multiple Python backend URLs with fallback
export const PYTHON_URLS = [
  PYTHON_URL_1 || PYTHON_URL,
  PYTHON_URL_2,
].filter(Boolean); // Filter out null/undefined values

// Debug log for configuration validation
if (NODE_ENV === "development" || process.env.DEBUG === "true") {
  if (!CLOUDINARY_API_KEY) {
    console.warn("[Config] WARNING: CLOUDINARY_API_KEY is not defined in .env");
  } else {
    console.log("[Config] Cloudinary credentials loaded successfully.");
  }
}
