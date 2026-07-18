# Build Plan — Step-by-Step Design & Decisions

Companion to `submission-requirements.md` (the *what* — the source of truth for all product decisions). This file is the *how*: the design of each part, in build order, with the decision made at every step. Based on researched best practices for Express + Prisma + Neon + Vercel.

---

## Part 0 — Architecture decisions (read once, apply everywhere)

**Layered structure.** Every feature flows through the same four layers. This is the most widely recommended Express pattern (separation of concerns):

1. **Route** — maps a URL + method to a controller. No logic.
2. **Controller** — reads the request, calls the service, sends the response. No business logic, no database.
3. **Service** — the business logic (scheduling rules, "is this item due?"). No knowledge of HTTP.
4. **Data access** — Prisma calls. Services use Prisma through one shared client.

Why: each piece is small, testable, and replaceable. The scheduling rules live in services, so they can be unit-tested without a running server.

**Folder structure:**

```
project/
├── api/
│   └── index.js          # Vercel entry point: imports and exports the app
├── src/
│   ├── app.js            # builds the Express app (middleware + routes), EXPORTS it
│   ├── server.js         # local dev only: imports app, calls app.listen()
│   ├── routes/           # items.routes.js, auth.routes.js
│   ├── controllers/      # items.controller.js, auth.controller.js
│   ├── services/         # items.service.js, schedule.service.js, auth.service.js
│   ├── middleware/       # auth.js, errorHandler.js, validate.js
│   ├── dto/              # zod schemas (input) + mappers (output)
│   └── lib/
│       ├── prisma.js     # single shared Prisma client (singleton)
│       └── dates.js      # calendar-date helpers
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.js
├── tests/
│   └── schedule.test.js
├── implementation-journey.md   # committed, not ignored
├── vercel.json
└── .env                  # gitignored
```

Key decision: `app.js` **exports** the app instead of starting it. Local dev starts it via `server.js`; Vercel imports it via `api/index.js`. One codebase, two entry points — this is the exact pattern Vercel's Express guide uses.

**Middleware order in app.js (order matters):**
1. `helmet()` — security headers
2. `express.json({ limit: '64kb' })` — parse JSON bodies, capped (our items are max 10k chars)
3. Routes mounted at `/api/v1`
4. 404 handler — for unknown routes
5. Error handler — **always last**; produces the single error format

**The single Prisma client.** In serverless, every request can create a new database connection and exhaust Neon. Standard fix (from Prisma's own Vercel guidance): create the client once in `lib/prisma.js` using a global-variable singleton, and import it everywhere. Never `new PrismaClient()` anywhere else.

**Date rule implementation.** All schedule math uses plain `YYYY-MM-DD` strings and Postgres `DATE` columns. `lib/dates.js` has exactly three functions: `addDays(dateStr, n)`, `isDueOn(item, dateStr)`, `todayFrom(req)` (reads the client's `?date=` param and validates its format). No timestamps in schedule logic, ever.

---

## Part 1 — Project setup

Steps:
1. `git init`, create `.gitignore` (node_modules, .env) — journey log is NOT ignored
2. `npm init`, install: express, helmet, zod, bcrypt, jsonwebtoken, express-rate-limit; dev: nodemon, prisma, vitest, supertest
3. Create the folder skeleton above; `app.js` with helmet + json + a `GET /api/v1/health` route returning `{ status: 'ok' }`
4. `server.js` starts it locally on port 3000
5. Start the local database: Docker Compose file with Postgres (decided — Docker is a course requirement)
6. `npx prisma init`, point `DATABASE_URL` at the local database; create a committed `.env.example` documenting every variable

**Done when:** `curl localhost:3000/api/v1/health` returns ok, and the first journey-log entry exists.

---

## Part 2 — Database schema (first migration)

Prisma schema decisions:

- **users**: `id` (uuid), `email` (unique — enforced by the database), `passwordHash`, `role` (enum: USER | ADMIN, default USER), `isSuspended` (Boolean, default false), `createdAt`
- **items**: `id` (uuid), `userId` (FK → users), `text` (Text), `dateAdded` (DATE), `nextReviewDate` (DATE), `stage` (Int: 0 = awaiting 2-day, 1 = awaiting 7-day, 2 = awaiting 30-day), `isComplete` (Boolean, default false), `deletedAt` (DATE, nullable — null means not deleted)
- **reviews**: `id` (uuid), `itemId` (FK → items), `date` (DATE), `result` (enum: REVIEWED | SKIPPED)

Decisions made:
- `stage` stored on the item is the source of truth (not derived from counting reviews) — simpler queries
- Index on `(userId, nextReviewDate)` — the due-queue query uses exactly this
- The users table exists from migration #1 even though auth comes later — avoids a painful migration
- Until auth is built, a seed-created "dev user" owns all items

Run `prisma migrate dev --name init`. **Done when:** tables visible in Prisma Studio.

---

## Part 3 — Items CRUD (no auth yet, no scheduling yet)

Build in this exact order, one endpoint at a time, testing each in Postman before the next:

1. `POST /items` — input DTO: `{ text }` (non-empty, ≤10,000 chars). Sets `dateAdded` = client-provided date, `nextReviewDate` = dateAdded + 2, `stage` = 0. Returns the output DTO.
2. `GET /items` — query params `status=active|archived|all` (default active) and pagination `page` (default 1) + `limit` (default 20, max 100); response includes `{ items, page, limit, total }`. Excludes soft-deleted always. Output DTO includes `preview` (first line or 80 chars), never full text.
3. `GET /items/:id` — full text + review history (empty array for now). 404 via the standard error shape if missing, deleted, or (later) not yours.
4. `PATCH /items/:id` — text only. Schedule untouched.
5. `DELETE /items/:id` — sets `deletedAt`. Returns 204.

Cross-cutting decisions applied here:
- **validate.js middleware**: takes a zod schema, rejects bad input with a 400 in the standard error format — reused by every endpoint
- **Output mappers** in `dto/`: `toItemSummary(item)` (list view), `toItemDetail(item)` (single view). Controllers only ever return mapper output.
- **errorHandler.js**: one `AppError(status, code, message)` class; the handler formats everything, including unexpected crashes (500, generic message, real error only in server logs)

**Done when:** full CRUD works in Postman and invalid input produces the standard error shape.

---

## Part 4 — Scheduling logic (the heart)

All rules live in `services/schedule.service.js` as pure functions (no database, no HTTP — takes data in, returns data out). This makes them trivially testable.

1. `GET /items/due?date=YYYY-MM-DD` — items where `nextReviewDate <= date`, not complete, not deleted. Date param required and format-validated; missing/bad → 400. Empty result → `200 []`.
2. `POST /items/:id/review` — body: `{ date }` (the client's today). Rules, in order:
   - item exists, not deleted, not complete → else 404 / 409
   - item is due on that date (`nextReviewDate <= date`) → else **409 ITEM_NOT_DUE** (this one rule gives us both "no early reviews" and double-click protection)
   - record a REVIEWED row in reviews
   - advance: stage 0 → 1, next = date + 7; stage 1 → 2, next = date + 30; stage 2 → `isComplete = true` (archived)
   - note: intervals count from the **completion date** (the `date` sent), not from dateAdded — per spec
3. `POST /items/:id/skip` — same due-check; records a SKIPPED row; sets `nextReviewDate = date + 1`.
4. **Seed script** (`prisma/seed.js`): creates the dev user + items backdated so that, "today", there are items at every stage: due-today (stage 0, 1, and 2), overdue, not-yet-due, and archived. Without this the 7/30-day flows are untestable.
5. **Tests** (`tests/schedule.test.js`) for the pure functions: due today / overdue / not due / early attempt rejected / stage advance math / skip pushes one day / completed item rejects review / double review rejected. Aim for ~10 focused tests.

**Done when:** all tests pass and the full lifecycle (add → review ×3 → archived) can be walked through in Postman using seeded data.

---

## Part 5 — Auth

1. `POST /auth/register` — input DTO: email (valid format) + password (min 8 chars, must contain at least one letter and one number). Hash with **bcrypt** (cost 10). Duplicate email → 409. Never return the hash. Role defaults to USER.
2. `POST /auth/login` — verify password; wrong email and wrong password return the **same** 401 message (don't reveal which was wrong). Suspended users are rejected with 403. Success → JWT signed with `JWT_SECRET` env var, payload `{ userId, role }`, expiry 7 days.
3. **auth middleware** (`middleware/auth.js`) — reads `Authorization: Bearer <token>`, verifies, puts `userId` on the request; missing/invalid → 401 standard error.
4. Apply the middleware to **all item routes**; every service query now filters by the authenticated `userId`. Accessing someone else's item = 404 (not 403 — don't confirm the item exists).
5. **Rate-limit** `/auth/*` with express-rate-limit (e.g. 10 attempts / 15 min per IP).
6. Retire the "dev user" shortcut: seed script now creates a real test account you log in with, plus one admin account.
7. **Admin role**: `isAdmin` guard middleware (reads role from the JWT payload, 403 if not admin). Endpoints: `GET /admin/users` (paginated list — id, email, role, suspended, created; never hashes), `POST /admin/users/:id/suspend`, `POST /admin/users/:id/unsuspend`. Suspending takes effect at login (existing tokens are also rejected by a suspension check in the auth middleware). An admin cannot suspend themselves.

**Done when:** two registered users each see only their own items in Postman; the admin can suspend a user and that user can no longer log in; a normal user calling /admin routes gets 403.

---

## Part 6 — Docs, export, polish

1. **Swagger**: serve at `GET /api/v1/docs` via swagger-ui-express. Decision: write one `openapi.yaml` by hand rather than generating from comments — more learning, less magic. Cover every endpoint with one example request/response each.
2. `GET /export?includeDeleted=true|false` (default false) — everything belonging to the user (account info without the hash, items with full text and status, review history) as one JSON download; soft-deleted items included only when the flag is true.
3. **CI**: GitHub Actions workflow (`.github/workflows/ci.yml`) that installs dependencies and runs the Vitest suite on every push and pull request. Keep it to ~20 lines.
4. **README**: what the app is, the 2-7-30 rules in three sentences, endpoint table, how to run locally, link to the journey log, and a "known trade-offs" section (client-supplied date is trusted; no refresh tokens — both deliberate).

---

## Part 7 — Deployment (Neon + Vercel)

1. Create the Neon production database; copy the **pooled** connection string.
2. Create `api/index.js` (imports the app from `src/app.js`, exports it) and `vercel.json` with a rewrite sending every path to it — the researched standard pattern: the whole Express app runs as one serverless function.
3. `package.json` build additions: `"vercel-build": "prisma generate"` — required because Vercel caches node_modules and Prisma's generated client can go stale without it (a known, documented pitfall).
4. Decision — **migrations are run manually** against Neon (`prisma migrate deploy`) as a deliberate step, not automatically on every deploy. Simpler and safer for a solo learner.
5. Set Vercel environment variables: `DATABASE_URL` (pooled), `JWT_SECRET`.
6. Deploy. Verify in order: `/api/v1/health` → register → login → add item → due queue → review. Expect the first request after idle to be slow (cold start — normal).
7. Final journey-log entry + README badge/link to the live URL.

---

## Definition of done (whole project)

- Every endpoint in the spec works on the deployed URL
- Two users cannot see each other's data
- All scheduling tests pass
- Swagger page documents every endpoint
- Seed script recreates a full demo state with one command
- README + committed implementation-journey.md tell the story

## Decisions this plan just made (flagging them honestly)

- Layered routes/controllers/services structure (vs. everything-in-routes) — industry standard, worth the small overhead
- `stage` on the item is authoritative (vs. derived from review count)
- 409 for "not due" and double reviews (vs. 400) — 409 means "conflict with current state", the semantically right code
- Cross-user access returns 404 (vs. 403) — avoids leaking that an item exists
- bcrypt cost 10, JWT payload = userId only, rate limit 10/15min — sensible defaults, all adjustable
- Hand-written openapi.yaml (vs. generated) — chosen for learning value
- Manual production migrations (vs. auto on deploy) — chosen for safety/simplicity
- One serverless function for the whole app (vs. one per route) — the standard Express-on-Vercel pattern; also avoids Vercel's function-count limits on the free plan

If your course teaches a different convention for any of these, the course wins — tell Claude Code to adapt.
