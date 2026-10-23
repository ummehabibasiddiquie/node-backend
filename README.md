# QC Backend

Backend service for QC (Quality Check) workflows in HRMS.  
It handles tracker file processing, duplicate detection, AI-assisted evaluation, QC lifecycle management (regular/correction/rework), and email notifications.

## What This Service Does

- Exposes REST APIs under `/api/v1`.
- Reads tracker metadata from a Python backend (`PYTHON_URL`) and processes Excel data.
- Stores and updates QC state in MySQL (`qc_records`, `qc_rework_history`, `qc_correction_history`, `tracker_records`, etc.).
- Uploads generated sample/correction files to Cloudinary.
- Sends QC notification emails to agents.
- Runs optional AI-based evaluation using Gemini (`@ai-sdk/google`) with user-provided API key.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js |
| Language | TypeScript |
| HTTP Framework | Express 5 |
| Database | MySQL (`mysql2/promise`) |
| File Processing | `exceljs`, `xlsx`, `multer` |
| External Integrations | Python backend (tracker data), Cloudinary, SMTP, Gemini AI |
| Tooling | `nodemon`, `tsc`, ESLint |

## High-Level Architecture

```text
Client/Frontend
   -> Express routes (/api/v1/*)
      -> Controllers
         -> Services / Utils
            -> MySQL + External systems
               - Python backend (tracker/view)
               - Cloudinary (file storage)
               - SMTP (emails)
               - Gemini AI (evaluation)
```

## Directory Map

- `index.ts` -> app bootstrap, middleware, route mounting.
- `routes/` -> endpoint groups by domain.
- `controllers/` -> request handlers, orchestration, validation.
- `services/` -> reusable domain logic (QC lifecycle transitions).
- `database/` -> DB connection factory.
- `queries/` -> shared SQL query modules.
- `utils/` -> helper utilities (AI parsing, Cloudinary uploads, date formatting, path handling).
- `config/` -> env loading, AI and nodemailer setup, scaling config.
- `constants/` -> static templates (email HTML templates).
- `dist/` -> compiled output from TypeScript build.

## Key Request Flows

### 1) Tracker Processing Flow

1. Request hits `POST /api/v1/tracker/process-excel`.
2. Controller validates uploaded file and task config (`important_columns`, duplicate-check mode).
3. Rows are hashed (`sha256`) for duplicate detection:
   - within uploaded file
   - against existing `tracker_records`.
4. Valid rows are inserted into `tracker_records` with status `ready`.
5. `qc_performance` is updated with processing stats.

### 2) QC Save / Lifecycle Flow

1. Request hits `POST /api/v1/qc-records/save`.
2. Controller upserts `qc_records` by `tracker_id`.
3. Sample data may be generated/uploaded to Cloudinary.
4. `QCWorkflowService` transitions lifecycle:
   - `regular` -> complete flow
   - `correction` -> correction cycle history
   - `rework` -> rework cycle history
5. Related tracker status and side effects are updated.
6. Email is queued asynchronously via nodemailer.

### 3) AI Evaluation Flow

1. Request hits `POST /api/v1/ai/evaluate`.
2. Excel rows are read in batches.
3. Prompt is generated from task `important_columns`.
4. Gemini model evaluates records and returns structured JSON.
5. Results are aggregated and returned to client.

## API Surface (Current Route Groups)

Base URL: `http://localhost:<PORT>/api/v1`

- **Health**
  - `GET /` (welcome)
  - `GET /health`
- **Users**
  - `GET /users`
- **Tracker**
  - `GET /tracker/view`
  - `POST /tracker/process-excel`
- **AI**
  - `POST /ai/evaluate`
  - `POST /ai/duplicate-check`
- **Gemini Key**
  - `POST /gemini-key/save`
  - `POST /gemini-key/get`
  - `POST /gemini-key/delete`
- **QC Records**
  - `POST /qc-records/generate-sample`
  - `GET /qc-records/download-sample/:tracker_id`
  - `POST /qc-records/save`
  - `GET /qc-records/list`
  - `GET /qc-records/view/:id`
  - `PUT /qc-records/update/:id`
  - `POST /qc-records/agent-upload`
- **QC Status Buckets**
  - `POST /qc-regular/save`, `GET /qc-regular/list`
  - `POST /qc-correction/save`, `GET /qc-correction/list`
  - `POST /qc-rework/save`, `POST /qc-rework/save-regular`, `GET /qc-rework/list`
- **Mail**
  - `POST /mail/send-rework`

## Environment Variables

Copy `.env.example` to `.env` and fill required values.

```bash
cp .env.example .env
```

Expected keys used by the app include:

- **Server**: `PORT`, `NODE_ENV`, `SERVER_URL`
- **Database**: `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`
- **Python integration**: `PYTHON_URL`
- **SMTP**: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`
- **Cloudinary**: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- **Auth/meta**: `JWT_SECRET`, `JWT_EXPIRES_IN`

## Local Setup

### Prerequisites

- Node.js 18+ recommended
- MySQL database with required schema/tables
- Access to Python backend endpoint for tracker APIs
- Cloudinary account (for file uploads)
- SMTP credentials (for notifications)

### Install and Run

```bash
npm install
npm run dev
```

Server starts on `http://localhost:8000` by default (from `.env.example`).

## Scripts

- `npm run dev` -> run with nodemon (`index.ts`)
- `npm run build` -> compile TypeScript to `dist/`
- `npm start` -> run compiled server (`dist/index.js`)

## Coding Conventions in This Codebase

- Layered routing style: `routes -> controllers -> services/utils -> DB`.
- SQL is mostly written as raw query strings using `connection.execute(...)`.
- Controllers commonly manage transactions explicitly for multi-step QC operations.
- Files are mainly kebab-case (`qc-records.controller.ts`, `tracker-process.controller.ts`).
- Response envelope is generally `{ success, message?, data? }`.

## Common Developer Tasks

- **Add a new endpoint**
  1. Add handler in `controllers/`.
  2. Register route in relevant file under `routes/`.
  3. Mount route (if new route file) in `index.ts`.

- **Extend QC workflow logic**
  - Update `services/qc-workflow.service.ts`.
  - Ensure transitions remain consistent with `qc_records` and history tables.

- **Change AI evaluation behavior**
  - Update prompts/model logic in `config/ai.ts`.
  - Update parsing/aggregation helpers in `utils/ai-evaluation-utils.ts`.

- **Modify duplicate detection behavior**
  - Review hashing and DB duplicate logic in `controllers/tracker-process.controller.ts` and AI duplicate endpoints.

## Known Gaps / Notes

- No automated test suite is currently configured in `package.json`.
- Build output and source include paths should stay aligned (`index.ts` is entry point, output in `dist/`).
- `utils/connection-pool.ts` exists for scaling, while many flows still use per-request direct connections.
