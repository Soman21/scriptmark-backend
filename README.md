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
- Auth (signup/login, JWT, bcrypt)
- Marking guides with numbered questions and optional lettered subparts (1a, 1b...), draft/publish
- Marking sessions (course/exam) with department and faculty
- Multi page script uploads: each page OCR'd via Google Vision, combined per script
- Automatic student name/reg number detection from the front page (Groq), with manual override
- LLM scoring of a script against a marking guide (Groq, Llama 3.3 70B) — always a suggestion, never final
- Human confirmation of scores (updates status to REVIEWED)
- Continuous Assessment score entry per student
- Excel and PDF export of a session's results, with course/department/faculty header and computed grades

## Not built yet
- OTP based two factor login
- AI assistant chat with voice input/output
- Role based UI/API restrictions (Lecturer/Reviewer/Admin) — `requireRole()` exists in
  `src/middleware/auth.js` but is not yet applied to any route
