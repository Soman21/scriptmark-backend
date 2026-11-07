# ScriptMark — Backend API

Node.js + Express + Prisma (PostgreSQL) backend for ScriptMark.

## Stack
- Express (REST API)
- Prisma ORM
- PostgreSQL (via Supabase)
- JWT auth + bcryptjs for password hashing
- Google Cloud Vision (OCR)
- Groq (Llama 3.3 70B) for LLM scoring and student info extraction
- Supabase Storage (script images)
- ExcelJS + PDFKit (results export)

## 1. Database (Supabase)
Create a free project at supabase.com. Use the Connect button, ORM tab, Prisma,
to get your connection strings (pooled for `DATABASE_URL`, session pooler on
port 5432 for `DIRECT_URL`).

## 2. Storage and OCR/LLM credentials
1. Supabase: Storage, New bucket named exactly `script-images`, make it Public.
2. Supabase: Settings, API Keys, "Publishable and secret API keys", copy the Secret key.
3. Google Cloud Console: enable the Cloud Vision API, create a Service Account, download its JSON key.
4. Groq Console (console.groq.com): create a free API key.

## 3. Environment variables
Create a `.env` file in this folder with:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase pooled connection (port 6543) |
| `DIRECT_URL` | Supabase session pooler connection (port 5432) |
| `JWT_SECRET` | Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_EXPIRES_IN` | `7d` |
| `FRONTEND_URL` | `http://localhost:5173` (update after deploying) |
| `PORT` | `4000` |
| `SUPABASE_URL` | `https://[your-project-ref].supabase.co` |
| `SUPABASE_SECRET_KEY` | From step 2 |
| `GOOGLE_CREDENTIALS_JSON` | Entire contents of the downloaded `.json` key, minified to one line, single quoted |
| `GROQ_API_KEY` | From Groq console |

## 4. Install and migrate
```bash
npm install
npx prisma migrate dev --name init
npm run dev
```
Runs on `http://localhost:4000`. Check with `curl http://localhost:4000/api/health`.

## What this backend does
- Auth: signup, login with an email OTP step, JWT, bcrypt, password reset. Roles (Lecturer, Admin) are checked on routes with `requireRole()`.
- Lecturer profiles: faculty and department, auto staff ID (NAU0001...), admin suspend and restore.
- Marking guides: questions with lettered parts (1a, 1b...), draft and publish. Guides and question papers are read from PDF, Word or photos (Vision OCR for scanned pages, tables copied cell by cell, diagrams described by the vision model). The uploaded files and their text stay on the guide.
- Guide marks: printed heading marks such as "(4 Marks)" override the AI's reading; any mark value is allowed (decimals included).
- Marking points per part, with partial marks to 0.25, attempt marks for drawings without labels, and "Count: Best N" for "any N of M" parts.
- Exam total and answer rule on a guide (for example "Question 1 and any three others"), read from the paper. `studentMax()` gives what one student can score.
- Check totals and Fix all (`POST /api/guides/fixTotals`): suggests part and point marks that add up, using the AI only when the guide alone cannot decide. Nothing is saved until the lecturer applies and saves.
- Marking sessions grouped by course (Test, Assignment, Exam), with an Overview, notifications and course result sheets.
- Multi page script uploads: each page is OCR'd and combined per script. Page images are kept as colour JPEG for appeals.
- Student name and reg number detection from the front page, with manual override.
- AI scoring of a script against the guide (Groq, `openai/gpt-oss-120b`). It is always a suggestion, and drawn or table answers always go to review.
- Human confirmation of scores. Script totals follow the answer rule: every answer is marked, but only the compulsory questions and the best others count.
- CA score entry, Excel and PDF export with grades, analytics from confirmed scores.
- AI assistant chat for the guide, results and pages.
- Admin page: lecturers, admins and site activity.

## Database changes on the live site
Racle runs each stage's `live-migration.sql` in the Supabase SQL Editor before merging the backend pull request. The script adds the new columns and records the migration so Prisma skips it. Notes for each stage are in the project's `build-notes` folder.
