# Spaced Repetition Review Tracker

A backend for personal spaced-repetition learning. You save things you've
learned as short text items, and the system tells you exactly which items to
review each day using the **2-7-30 method**: the first review is due 2
calendar days after an item is added; after each completed review, the next
one is scheduled 7 and then 30 days out from the day you actually completed
it; after the third review the item is archived. Missing a day costs nothing
— an overdue item just waits in the queue until you get to it.

Built as a learning project (course: "AI agent co-pilot backend Express").
The full step-by-step story — what was built, why, and what went wrong along
the way — is in [`implementation-journey.md`](./implementation-journey.md).

**Live API:** https://solidify-with-2-7-30-git-main-thureinss-projects.vercel.app
(Swagger docs at `/api/v1/docs`)

**Live frontend:** https://solidify-with-2-7-30-7dc4.vercel.app

## Stack

Node.js + Express, PostgreSQL via Prisma, JWT auth (bcrypt password
hashing), Zod validation, Vitest for the scheduling-logic tests, Docker
Compose for local Postgres, GitHub Actions for CI.

**Bonus: a background email queue** (BullMQ + Redis + nodemailer) sends a
welcome email when a user registers. The API stays a plain serverless-style
Express app; the queue's consumer (`worker.js`) is the one piece of this repo
that runs in its own Docker container (see `Dockerfile`), because a queue
consumer has to run forever listening for jobs -- something a serverless
function fundamentally can't do. The API (producer) and worker (consumer)
never talk to each other directly, only through Redis. See
`implementation-journey.md` for the full build story.

A React (Vite) frontend covering every one of the 14 backend endpoints
(auth, items CRUD, due/review/skip, export, admin panel) lives in
[`frontend/`](./frontend) -- bonus scope beyond the original course spec,
kept isolated with its own `package.json` and not part of the backend's
CI/deploy. See its README for how to run it.

## Running locally

```bash
cp .env.example .env          # then set JWT_SECRET to a random string, e.g.:
                               # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
docker compose up -d          # starts local Postgres, Redis, and the email worker
npx prisma migrate deploy     # applies the committed migrations
npm run seed                  # creates demo@example.com / Demo1234 (USER)
                               # and admin@example.com / Admin1234 (ADMIN)
npm run dev                   # starts the server on :3000
npm test                      # runs the scheduling unit tests
```

API docs (Swagger UI, every endpoint with an example): `GET /api/v1/docs`.

### Email queue (optional)

The welcome-email worker needs a real Gmail account to actually send mail.
Without it, everything else works exactly the same -- registering still
succeeds, the app just enqueues no job (see `src/lib/emailQueue.js`'s
`REDIS_URL`-gated null-guard) or the worker fails to authenticate with Gmail
(harmless -- BullMQ retries 3x with backoff, then leaves the job in the
failed set for inspection).

1. Turn on 2-Step Verification on a Gmail account, then create an **App
   Password** at https://myaccount.google.com/apppasswords
2. Set `GMAIL_USER` (the Gmail address) and `GMAIL_APP_PASSWORD` (the
   16-character App Password) in `.env`
3. `docker compose up -d --force-recreate worker` -- `env_file` values are
   only read when a container is *created*, so a plain `restart` won't pick
   up credentials added after the container first started
4. Register a new account and check `docker compose logs -f worker`

## Deploying (Neon + Vercel)

1. Create a Vercel project from this repo and, from the Vercel Marketplace,
   install the **Neon** integration ("Vercel-managed" option creates the Neon
   account/project for you). It auto-injects `DATABASE_URL` (pooled) and
   `DATABASE_URL_UNPOOLED` (direct) as Vercel environment variables.
2. Add `JWT_SECRET` yourself in Vercel's project environment variables (any
   long random string, same as local).
3. Apply migrations to Neon once, manually, from your machine, using the
   **direct** (unpooled) connection string — pooled connections don't
   reliably support the locking Prisma Migrate needs:
   ```bash
   DATABASE_URL_UNPOOLED="<paste Neon's direct connection string>" npx prisma migrate deploy
   ```
4. Deploy. Vercel auto-detects the Express app straight from `src/app.js`
   (no `vercel.json` or extra entry file needed for the standard case).
5. Verify on the deployed URL, in order: `/api/v1/health` → register → login
   → add an item → due queue → review → **open `/api/v1/docs` in a browser
   and confirm it actually renders** (Swagger UI serves static assets via
   `express.static`, which Vercel's docs flag as unsupported in some cases —
   don't assume a 200 on the HTML means the page looks right; if the styling
   is broken, point `swaggerUi.setup()` at a CDN copy of the CSS/JS instead
   of the locally-bundled one).
6. First request after idle will be slow (cold start) — that's normal.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/v1/auth/register` | — | email + password (min 8 chars, 1 letter, 1 number) |
| POST | `/api/v1/auth/login` | — | rate-limited (10 / 15 min per IP) |
| GET | `/api/v1/auth/me` | user | own account info, never the password hash |
| GET | `/api/v1/health` | — | liveness check |
| POST | `/api/v1/items` | user | `{ text, date }` |
| GET | `/api/v1/items` | user | `?status=active\|archived\|all&page=&limit=` |
| GET | `/api/v1/items/due` | user | `?date=YYYY-MM-DD` |
| GET | `/api/v1/items/:id` | user | full text + review history |
| PATCH | `/api/v1/items/:id` | user | text only, schedule unchanged |
| DELETE | `/api/v1/items/:id` | user | soft delete |
| POST | `/api/v1/items/:id/review` | user | `{ date }`, must be due |
| POST | `/api/v1/items/:id/skip` | user | `{ date }`, pushes due date by 1 day |
| GET | `/api/v1/export` | user | `?includeDeleted=true\|false` |
| GET | `/api/v1/admin/users` | admin | paginated |
| POST | `/api/v1/admin/users/:id/suspend` | admin | can't suspend self |
| POST | `/api/v1/admin/users/:id/unsuspend` | admin | |

Every error response uses one shape: `{ "error": { "message", "code" } }`.

## Known trade-offs (deliberate)

- **The client-supplied "today" date is trusted.** All scheduling math uses
  the date the client sends, never the server clock — this keeps the app
  timezone-safe, and since it's a personal tool, a user could at most cheat
  their own review schedule.
- **No refresh tokens.** A single 7-day JWT access token is the whole auth
  story — simpler, at the cost of a week-long token lifetime if one leaks.
- **No password recovery, email reminders, file upload, tags, or
  statistics in this MVP** — backlogged deliberately to keep scope to the
  spec.
