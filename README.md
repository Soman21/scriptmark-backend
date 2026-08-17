# ScriptMark — Backend API

Node.js + Express + Prisma (PostgreSQL) backend for ScriptMark.

## Stack
- Express (REST API)
- Prisma ORM
- PostgreSQL (via Supabase for both local dev and production)
- JWT auth (`jsonwebtoken`) + `bcryptjs` for password hashing

## 1. Create your free database (Supabase)
1. Go to https://supabase.com → New Project (free tier).
2. Click the **Connect** button at the top of your project → **ORM** tab → **Prisma** to get your connection strings.
3. You'll need both the pooled connection (port 6543) and a session/direct connection (port 5432, for migrations).

## 2. Set up Storage (for script images) and Vision OCR credentials
1. In Supabase: **Storage** → New bucket → name it exactly `script-images` → make it Public.
2. In Supabase: **Settings → API Keys → "Publishable and secret API keys"** → copy the **Secret key** (`sb_secret_...`).
3. In Google Cloud Console: create a project → enable the **Cloud Vision API** → create a Service Account → generate a JSON key → download it.

## 3. Configure environment variables
Create a file named `.env` in this folder (there's no `.env.example` template — the values below are sensitive, so they're documented here instead) with:

| Variable | Example / where to get it |
|---|---|
| `DATABASE_URL` | Supabase pooled connection string (port 6543) |
| `DIRECT_URL` | Supabase session pooler connection string (port 5432) |
| `JWT_SECRET` | Generate with: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `JWT_EXPIRES_IN` | `7d` |
| `FRONTEND_URL` | `http://localhost:5173` (update after deploying) |
| `PORT` | `4000` |
| `SUPABASE_URL` | `https://[your-project-ref].supabase.co` |
| `SUPABASE_SECRET_KEY` | The Secret key from step 2 above |
| `GOOGLE_CREDENTIALS_JSON` | The entire contents of your downloaded `.json` key file, minified to one line, wrapped in single quotes: `GOOGLE_CREDENTIALS_JSON='{"type":"service_account",...}'` |

## 4. Install dependencies and create the database tables
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

## 5. Run the API locally
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
| POST | `/api/sessions/:id/scripts` | Yes | Upload a script image (`multipart/form-data`, field `image`) — runs OCR automatically and saves extracted text |
| PUT | `/api/results/:answerId/confirm` | Yes | Lecturer confirms/edits a score |
| PUT | `/api/results/scripts/:scriptId/flag` | Yes | Flag a script for review |

Send the JWT on protected routes as: `Authorization: Bearer <token>`

## Not built yet (next phase)
- LLM scoring integration (compare extracted OCR text to the marking guide and suggest a score)

## Deploying later (Railway)
1. Push this backend folder to its own GitHub repo (or a `backend/` folder
   in a monorepo).
2. On https://railway.app → New Project → Deploy from GitHub repo.
3. Add the same environment variables (`DATABASE_URL`, `JWT_SECRET`,
   `FRONTEND_URL` — set this to your real Vercel URL once you have it).
4. Railway will run `npm install` then `npm start` automatically.
5. Copy the Railway-generated URL and put it in the frontend's
   `VITE_API_URL` environment variable on Vercel.
