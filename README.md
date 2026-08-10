# ScriptMark — Backend API

Node.js + Express + Prisma (PostgreSQL) backend for ScriptMark.

## Stack
- Express (REST API)
- Prisma ORM
- PostgreSQL (via Supabase for both local dev and production)
- JWT auth (`jsonwebtoken`) + `bcryptjs` for password hashing

## 1. Create your free database (Supabase)
1. Go to https://supabase.com → New Project (free tier).
2. Once it's created: **Project Settings → Database → Connection string → URI**.
3. Copy the "Transaction" pooled connection string — it looks like:
   `postgresql://postgres.xxxx:[PASSWORD]@aws-0-xxxx.pooler.supabase.com:6543/postgres`
4. You'll use this **same connection string locally and in production** — there's
   only one database, so your local dev and your deployed app share data
   (fine for a student project; you can create a second Supabase project
   later if you want separate dev/prod databases).

## 2. Configure environment variables
```bash
cp .env.example .env
```
Fill in:
- `DATABASE_URL` — the Supabase connection string from step 1
- `JWT_SECRET` — generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `FRONTEND_URL` — `http://localhost:5173` for now

## 3. Install dependencies and create the database tables
```bash
npm install
npx prisma migrate dev --name init
```
This reads `prisma/schema.prisma` and creates the actual tables (User,
MarkingGuide, Question, MarkingSession, Script, ScriptAnswer) in your
Supabase database.

Optional — open a visual browser of your tables:
```bash
npx prisma studio
```

## 4. Run the API locally
```bash
npm run dev
```
It starts on `http://localhost:4000`. Check it's alive:
```bash
curl http://localhost:4000/api/health
```

## API routes so far
| Method | Route | Auth? | Purpose |
|---|---|---|---|
| POST | `/api/auth/signup` | No | Create account, returns JWT |
| POST | `/api/auth/login` | No | Log in, returns JWT |
| GET | `/api/guides` | Yes | List all marking guides |
| POST | `/api/guides` | Yes | Create a marking guide + questions |
| GET | `/api/guides/:id` | Yes | Get one guide with its questions |
| GET | `/api/sessions` | Yes | List marking sessions |
| POST | `/api/sessions` | Yes | Create a marking session |
| GET | `/api/sessions/:id/scripts` | Yes | List scripts in a session |
| POST | `/api/sessions/:id/scripts` | Yes | Register a scanned script |
| PUT | `/api/results/:answerId/confirm` | Yes | Lecturer confirms/edits a score |
| PUT | `/api/results/scripts/:scriptId/flag` | Yes | Flag a script for review |

Send the JWT on protected routes as: `Authorization: Bearer <token>`

## Not built yet (next phases)
- Google Cloud Vision OCR integration (script image → text)
- LLM scoring integration (compare extracted text to marking guide)
- File/image upload & storage (scripts are currently just URLs/text in the DB)

## Deploying later (Railway)
1. Push this backend folder to its own GitHub repo (or a `backend/` folder
   in a monorepo).
2. On https://railway.app → New Project → Deploy from GitHub repo.
3. Add the same environment variables (`DATABASE_URL`, `JWT_SECRET`,
   `FRONTEND_URL` — set this to your real Vercel URL once you have it).
4. Railway will run `npm install` then `npm start` automatically.
5. Copy the Railway-generated URL and put it in the frontend's
   `VITE_API_URL` environment variable on Vercel.
