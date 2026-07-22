# Developer Handover — Spaced Repetition Review Tracker

Written for someone picking up this codebase with zero prior context. For
the story of *why* things were built the way they were (decisions,
problems hit, concepts explained) see [`implementation-journey.md`](./implementation-journey.md)
— that file is the detailed session-by-session log; this one is the
snapshot of current state.

## 1. What this is

A backend (+ bonus frontend) implementing spaced-repetition learning: a user
saves text items, the system schedules reviews on a **2-7-30** cadence (2
days after adding → 7 days after the first review → 30 days after the
second → archived), and tells the user exactly what's due each day.

Originally a course project (`submission-requirements.md` is the frozen
original spec — see §9 below for how that relates to what's actually built).

**Live:**
- Backend: https://solidify-with-2-7-30-git-main-thureinss-projects.vercel.app
  (Swagger docs at `/api/v1/docs`)
- Frontend: https://solidify-with-2-7-30-7dc4.vercel.app

## 2. Stack

| Concern | Choice | Why (brief) |
|---|---|---|
| Runtime | Node.js + Express 5 | Course requirement |
| Database | PostgreSQL via Prisma 7 (driver adapter: `@prisma/adapter-pg`) | Prisma 7 dropped the old engine-binary connection model; adapters are the supported path now |
| Auth | JWT (7-day, no refresh) + bcrypt | Deliberately simple; see §8 |
| Validation | Zod | One schema per endpoint, rejects bad input with a consistent 400 |
| Background jobs | BullMQ (Redis-backed) + nodemailer | Welcome-email-on-register; see §6 |
| Local infra | Docker Compose (Postgres, Redis, the email worker) | API/frontend still run on the host via `nodemon`/`vite` |
| Tests | Vitest | Pure-function scheduling logic only — no DB in CI |
| CI | GitHub Actions | checkout → Node 22 → `npm ci` → `npm test` (`prisma generate` runs via `postinstall`) |
| Prod DB | Neon Postgres | Pooled `DATABASE_URL` for runtime, unpooled `DATABASE_URL_UNPOOLED` for migrations |
| Prod hosting (API) | Vercel (serverless, zero-config Express detection) | Auto-deploys on push to `main` |
| Frontend | React + Vite, separate Vercel project | Isolated `package.json`, not in backend CI |

## 3. Repo layout

```
src/
  app.js                  Express app (exported, no .listen()) — helmet, morgan,
                           CORS, JSON body parsing, routes, 404, error handler
  server.js               Calls app.listen() — the only file that starts a server
  routes/                 One file per resource: auth, items, export, admin
  controllers/            Thin — parse req, call a service, map the result, respond
  services/                Business logic. schedule.service.js is PURE (no Prisma,
                           no req/res) — see §5
  dto/                    Zod input schemas (*.schemas.js) + output mappers (*.mappers.js)
  middleware/             auth (JWT verify + fresh DB suspension check), isAdmin,
                           authRateLimit, validate (schema-driven), errorHandler
  lib/                    prisma.js, redis.js, emailQueue.js (singletons), jwt.js, dates.js

prisma/
  schema.prisma           3 models: User, Item, Review (see §4)
  seed.js                 Wipes + recreates demo@example.com's items every run;
                           creates admin@example.com once (upsert)
  migrations/             2 migrations, committed

tests/schedule.test.js    14 unit tests against schedule.service.js's pure functions

worker.js                 Root-level (matches seed.js's convention) — BullMQ
                           Worker consuming the 'emails' queue, sends via
                           nodemailer/Gmail SMTP, graceful SIGTERM/SIGINT shutdown

Dockerfile                Worker-only image (node:20-alpine, --omit=dev, --ignore-scripts)
docker-compose.yml        db + redis + worker services (API/frontend stay on host)
openapi.yaml              Hand-written OpenAPI 3.0 spec, served via swagger-ui-express
                           at /api/v1/docs

frontend/                 React (Vite), isolated package.json, own README
```

## 4. Data model

```
User (users)                Item (items)                    Review (reviews)
─────────────                ────────────                    ────────────────
id            uuid PK        id             uuid PK          id       uuid PK
email         unique         userId         FK → User.id     itemId   FK → Item.id
passwordHash                 text                             date     DATE
role          USER|ADMIN     dateAdded      DATE              result   REVIEWED|SKIPPED
isSuspended   bool           nextReviewDate DATE
createdAt                    stage          Int (0/1/2)
                              isComplete     bool
                              deletedAt      DATE, nullable   ← soft delete
```

Key points for anyone touching this:
- **`stage` is the source of truth for schedule progress** — not derived by
  counting `Review` rows. Keeps "is this due?" a single-row check.
- **Date-only columns use Postgres `DATE`** (`@db.Date`), not timestamps —
  the whole app deliberately works in whole calendar days, no time-of-day
  noise. See §7 for why this matters more than it sounds like it should.
- **`@@index([userId, nextReviewDate])`** on `Item` — the exact shape of the
  "what's due" query.
- **Soft delete**: `deletedAt` set, row stays. Every normal query filters
  `deletedAt: null`; export's `includeDeleted=true` is the one path that
  doesn't.
- Table names are lowercase (`@@map`) even though Prisma model names are
  capitalized — matters if you ever write raw SQL.

## 5. The scheduling logic (the one thing worth understanding deeply)

`src/services/schedule.service.js` exports three **pure functions**:
`isDueOn`, `applyReview`, `applySkip`. Pure means: plain data in, plain data
out (or a thrown `AppError`), zero Prisma calls, zero `req`/`res`. This is
deliberate — it's what makes 14 unit tests possible with no database at all
(`tests/schedule.test.js`).

The one rule worth knowing: **`nextReviewDate <= today` is the *only* due
check**, and it simultaneously blocks two things — reviewing early, and
double-submitting a review on the same item on the same day (the first
review already advanced `nextReviewDate` past today, so a second attempt
fails the same check). One rule, two guarantees.

`items.service.js` does the actual orchestration: fetch the item, hand it to
the pure function, persist the result. `reviewItem`/`skipItem` both write the
`Review` insert and the `Item` update inside one `prisma.$transaction([...])`
— a crash between the two can never leave a review recorded without the
schedule advancing.

## 6. The email queue (bonus feature)

**Scope:** welcome email on register only. No due-date reminder scheduler
(that's still backlogged — see §9).

```
auth.service.js registerUser()          worker.js (separate process)
   |                                          |
   | prisma.user.create(...)                  | BullMQ Worker on 'emails' queue
   | emailQueue.add('welcome', {...})         | pulls jobs, calls nodemailer
   |   .catch(console.error)  <- never awaited|   -> Gmail SMTP (port 465)
   v                                          v
 return user immediately              sends email / retries 3x w/ backoff
              \                       /
               \                     /
                 Redis (bull:emails:*)
```

- **`src/lib/emailQueue.js`** exports a BullMQ `Queue`, or `null` if
  `REDIS_URL` is unset (prod today — see §8). Uses its **own** ioredis
  connection (`maxRetriesPerRequest: null`), deliberately separate from
  `src/lib/redis.js`'s singleton — that one is configured to fail fast
  (`enableOfflineQueue: false`, for the health check's sake); BullMQ needs
  the opposite (buffer through a blip, don't drop the job).
- **Producer** (`auth.service.js`): fire-and-forget, `.catch()`'d, never
  `await`ed inline — a queue/Redis failure must never turn a successful
  registration into a 500.
- **Consumer** (`worker.js`): its own process, its own container. Why
  containerized when nothing else in this repo is: a queue consumer has to
  run forever, listening — which a serverless function (the API's
  deployment model) fundamentally cannot do. `Dockerfile` builds it with
  `--ignore-scripts` (skips `prisma generate` — worker is DB-free) and
  `--omit=dev` (skips devDependencies it doesn't need).
- **Gotcha if you're testing this**: `docker compose restart worker` does
  **not** pick up new `.env` values — `env_file` is only read when a
  container is *created*. Use `docker compose up -d --force-recreate
  worker` after changing `GMAIL_USER`/`GMAIL_APP_PASSWORD`.
- **Not deployed live** — no free host runs a persistent process
  (Railway/Render/Fly + a managed Redis like Upstash would all be paid,
  ~$5/mo). The code is correct either way: with no `REDIS_URL`, registration
  still succeeds, it just enqueues nothing.

## 7. Timezone / date handling

**Every scheduling operation trusts a client-supplied date string**
(`YYYY-MM-DD`), never the server clock. `src/lib/dates.js`'s `parseDate`
turns that string into a UTC-midnight `Date`; all Postgres date columns are
`@db.Date` (no time component). This is why `new Date().toISOString()`
(which gives the *UTC* date — often a day off from the user's actual
calendar date) would be wrong for computing "today" — the frontend
deliberately uses local date components (`getFullYear`/`getMonth`/`getDate`)
instead. Accepted trade-off: a user could only cheat *their own* schedule by
sending a fake date — fine for a personal tool.

## 8. Auth & security notes

- **JWT, 7-day expiry, no refresh tokens.** Deliberate simplification —
  documented as an accepted trade-off in `submission-requirements.md`.
- **`requireAuth` re-fetches the user from the DB on every request** instead
  of trusting the JWT's embedded role/suspension state — required so a
  suspension takes effect on an *already-issued* token immediately, not just
  on next login. Costs one extra query per authenticated request; accepted.
- **Login returns the same 401 for "wrong password" and "unknown email"** —
  prevents account enumeration.
- **Rate limiting** (`express-rate-limit`, 10/15min per IP) is scoped to
  `/auth/register` and `/auth/login` only, not the whole `/auth` router.
- **CORS** is an explicit allowlist (`CORS_ORIGIN`, comma-separated),
  defaulting to the Vite dev port — the API sent no CORS headers at all
  until the frontend needed it.
- **No refresh-token store yet.** If that gets built later (see §9), it'll
  need Redis for revocation — infra's already in place.

## 9. Relationship between the docs in this repo

- `submission-requirements.md` / `build-plan.md` — the **original**,
  frozen course spec and build plan. **Policy: don't add new sections here
  for bonus work** — only fix outright factual errors (e.g. a stale
  "backlogged" claim that's since been built). These exist to show what was
  originally scoped vs. what got added later.
- `implementation-journey.md` — the **living changelog**. Every feature,
  bonus or not, gets a dated entry here: what was built, why, what broke,
  concepts introduced. This is the actual history; read it if you want the
  reasoning behind any decision above.
- `README.md` / `frontend/README.md` — developer setup instructions. Kept
  current (unlike the frozen plan docs).
- `user-manual.md` — end-user facing guide, no technical content.
- `openapi.yaml` — the API reference, served live at `/api/v1/docs`.
- `CLAUDE.md` — instructions for the AI pair-programming workflow used to
  build this (course context: a beginner + an AI co-pilot). Not relevant to
  running the app, relevant if you're continuing that workflow.

## 10. Running it

See `README.md` — it has the actual commands (local run, tests, Docker,
deploy). Not duplicating them here since that file is the one kept
guaranteed current.

## 11. Known gaps / backlog (nothing here blocks the app working)

- **Neon prod DB password was exposed in an AI chat session (2026-07-18),
  never rotated.** Do this before treating the prod DB as fully secure.
- **Refresh tokens** — would conflict with the graded spec's explicit
  "no refresh tokens" decision if not clearly scoped as bonus; Redis-backed
  revocation is the natural design if built.
- **Due-date email reminders** (a scheduler, distinct from the welcome email
  already built) — explicitly backlogged in the original spec, not started.
- **Password recovery, file upload, tags, statistics** — explicitly
  backlogged in the original spec, not started.
- **Worker + Redis don't run in production** — see §6; purely a hosting-cost
  gap, not a code gap.
