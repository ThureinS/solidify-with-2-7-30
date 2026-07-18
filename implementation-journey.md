# Implementation Journey

## 2026-07-18 — Part 1: Project setup

**What was built**
- Node/Express project skeleton: `src/app.js` (builds the Express app, exports it) and `src/server.js` (starts it locally on port 3000). This split matters later — Part 7 will import `app.js` from a Vercel serverless function without ever calling `.listen()`.
- Middleware wired in `app.js`, in order: `helmet()` (security headers), `morgan('dev')` (one log line per request), `express.json({ limit: '64kb' })` (parses JSON bodies, capped in size), the `GET /api/v1/health` route, and a catch-all 404 handler returning our standard error shape.
- `docker-compose.yml` running Postgres 16 locally on port 5432.
- Prisma initialized (`prisma/schema.prisma`, `prisma.config.ts`), `.env` (real, gitignored) and `.env.example` (committed template) documenting `DATABASE_URL` and `PORT`.
- `.gitignore` created before anything else, so `.env`, `node_modules/`, and `.DS_Store` were never at risk of being committed.

**Key decisions and why**
- **CommonJS (`require`/`module.exports`)**, not ES modules. Simpler mental model for a first Express project — no `import`/`__dirname` complications.
- **morgan over pino** for request logging. The goal was "one readable line per request/response in local and Vercel logs" — morgan does exactly that with near-zero setup. Pino is a structured-JSON logger built for production log pipelines (Datadog, etc.) — more machinery than we need.
- **`node --env-file=.env`** instead of the `dotenv` package for loading environment variables into the app. Node 22 supports `--env-file` natively, so no extra dependency for something the runtime already does. (`dotenv` is still installed, but only because Prisma's own config file needs it — see below.)

**Problems hit and how they were solved**
- The installed Prisma version is **7.8.0** — newer than what `build-plan.md` assumed. I tested this empirically rather than guessing:
  - `datasource db { url = env("DATABASE_URL") }` in `schema.prisma` is no longer valid — Prisma 7 rejects it outright.
  - Passing a connection string directly to `new PrismaClient({ datasources: ... })` is also rejected.
  - Prisma 7 requires a **driver adapter**: an object that wraps a real Postgres client library (`pg`) and gets handed to `PrismaClient` explicitly. Confirmed working with `@prisma/adapter-pg` + `pg` — a test query (`SELECT 1`) succeeded.
  - I raised this to you directly instead of silently reworking the plan, and you chose: **stay on Prisma 7, use the driver adapter** (vs. downgrading to Prisma 6 to match the doc literally). Reasoning: driver adapters are the direction Prisma is permanently moving (the old engine-binary approach is being phased out), so it's worth the small extra concept now.
  - Practical effect: `prisma.config.ts` (a small TypeScript file, but only ever run by the Prisma CLI — not part of our app) holds the `DATABASE_URL` for *migrations*. `lib/prisma.js` (built in Part 2) will hold the *runtime* connection via the adapter. Two separate paths to the same database, for two separate purposes.
- Docker Desktop wasn't running when we started — had to launch it and wait for the daemon before `docker compose up` would work.

**New concepts introduced**
- **Middleware**: a function that runs on every request before it reaches your route handler — used here for security headers, logging, and body parsing.
- **Driver adapter**: in Prisma 7, the object that tells `PrismaClient` how to actually open a database connection (as opposed to Prisma doing it invisibly via a bundled binary).
- **Singleton pattern** (mentioned, not yet built): creating one shared object (the Prisma client) instead of a new one per request — avoids exhausting database connections, especially important in serverless.

**You should be able to explain**
1. Why `app.js` exports the Express app instead of starting the server itself, and what `server.js` adds on top.
2. What each of the three middleware lines in `app.js` (`helmet`, `morgan`, `express.json`) actually does, in your own words.
3. Why Prisma 7 needs a "driver adapter" to connect to Postgres, and what problem that solves compared to just handing it a connection string.

## 2026-07-18 — Part 2: Database schema

**What was built**
- `prisma/schema.prisma` now has all three models from the spec: `User`, `Item`, `Review`, plus two enums (`Role`, `ReviewResult`).
- First migration (`prisma/migrations/20260718063706_init/`) applied to the local Postgres container. Verified directly against the running database with `psql \d` — not just assumed from the schema file — that every column, type, default, and the foreign keys came out exactly as intended.
- Ran a throwaway smoke-test script (not committed) that created a user, an item, and a review through the real Prisma Client + driver adapter, queried the item back with its review included, then deleted everything. This proved the whole chain works end to end: schema → migration → generated client → adapter → real query — before writing any route code on top of it.

**Key decisions and why**
- **`stage` (an integer on `Item`) is the source of truth for review progress** — not derived by counting rows in `Review`. Simpler queries later ("is this item due?" only ever looks at one row), at the cost of trusting `stage` and `nextReviewDate` to always be updated together (Part 4's job).
- **Date-only columns use Postgres's real `DATE` type** (`@db.Date` in Prisma), not a full timestamp. `dateAdded`, `nextReviewDate`, `deletedAt`, and `Review.date` all use this — confirmed in `psql` that their column type is `date`, not `timestamp`. This matters because the spec requires all scheduling math to work in whole calendar days, with no timezone/time-of-day noise creeping in.
- **Index on `(userId, nextReviewDate)`** on `Item` — this is the exact shape of the "what's due today" query Part 4 will run, so the database can answer it without scanning every row.
- **Table names mapped to lowercase (`users`, `items`, `reviews`)** via `@@map(...)`, even though the Prisma model names stay `User`/`Item`/`Review`. Small implementation detail: avoids case-sensitivity surprises if we ever write raw SQL against Postgres, which is case-sensitive for unquoted identifiers.

**Problems hit and how they were solved**
- None — Part 1's Prisma-7 groundwork (driver adapter) meant the smoke test worked on the first real attempt once `prisma generate` was re-run after editing the schema.

**New concepts introduced**
- **Migration**: a versioned, ordered SQL script that changes the database's shape (create/alter tables). Each one is a file Prisma generates and applies for you — `prisma/migrations/<timestamp>_init/migration.sql` — so the schema's history is tracked in git, not just "whatever the database currently looks like."
- **Foreign key**: a column (`Item.userId`, `Review.itemId`) whose value must match a real row in another table (`users.id`, `items.id`). Postgres enforces this itself — you cannot insert an item pointing at a user that doesn't exist.

**You should be able to explain**
1. Why `stage` lives directly on the `Item` row instead of being calculated by counting reviews each time.
2. Why `nextReviewDate` is a `DATE` column and not a full timestamp — what problem would timestamps cause for this app specifically?
3. What a migration file actually is, and why it's committed to git instead of just changing the database directly.

## 2026-07-18 — Part 3: Items CRUD (no auth, no scheduling yet)

**What was built**
- Full layered stack for items, following Route → Controller → Service → Prisma: `routes/items.routes.js`, `controllers/items.controller.js`, `services/items.service.js`.
- All five endpoints from the spec: `POST /items`, `GET /items` (paginated, status filter), `GET /items/:id` (full text + review history), `PATCH /items/:id` (text only), `DELETE /items/:id` (soft delete, 204).
- `middleware/validate.js` — a reusable middleware factory that takes a zod schema and rejects bad input with our standard 400 error shape.
- `middleware/errorHandler.js` — the single place every error becomes the standard `{ error: { message, code } }` shape, including mapping specific Prisma errors (unique constraint → 409, record not found → 404) so raw database errors never reach the client.
- `dto/item.schemas.js` (zod input validation) and `dto/item.mappers.js` (`toItemSummary` for lists — preview only, no full text; `toItemDetail` for single-item views — full text + review history).
- `lib/dates.js` gained `parseDate` (turns a `YYYY-MM-DD` string into a UTC-midnight `Date`) and `addDays`, used to compute `nextReviewDate = dateAdded + 2` on creation.
- `lib/devUser.js` + `middleware/devUser.js` — a **temporary** stand-in for auth: every request is treated as belonging to one fixed dev user until Part 5 replaces this with real JWT auth. `prisma/seed.js` creates that dev user (will grow in Part 4 to also seed backdated items at every schedule stage).
- Tested every endpoint and every error path by hand (curl in place of Postman): valid/invalid creates, pagination, list excluding soft-deleted items, 404 on missing/deleted items, empty-text rejection, and the soft-delete-then-refetch flow.

**Key decisions and why**
- **Cross-user / soft-deleted access returns 404, not 403** — `getItemById`, `updateItemText`, and `softDeleteItem` all filter by `{ id, userId, deletedAt: null }` in one query, so a missing item and someone else's item look identical from the outside. This is deliberate: confirming "this ID exists, you just can't touch it" leaks information (Part 5 will make the userId scoping meaningful once real users exist).
- **`POST /items` requires `date` in the body**, not just `text`. Flagged this as a genuine gap in `build-plan.md` (its DTO showed `{ text }` only, but the very next clause required a client-supplied date) — resolved by requiring `{ text, date }`, consistent with how `due`/`review`/`skip` will all take `date` in Part 4.
- **`DELETE` does *not* take a client date** — `deletedAt` is only ever checked for null/not-null (a boolean-ish flag), never compared against "today" in schedule math, so there's no timezone bug to avoid here. Server clock is fine for this one field specifically.

**Problems hit and how they were solved**
- **Express 5 broke query-param validation.** The plan was: validate `req.query` with zod, then write the coerced/defaulted values back onto `req.query`. That's how Express 4 always worked. In Express 5, `req.query` is a **read-only getter** that re-parses the raw URL on every single access — I confirmed this directly (two reads of `req.query` in the same request handler returned two different object instances), so neither reassigning nor mutating it persists. `?page=1&limit=1` was silently passing the *strings* `"1"` all the way to Prisma, which rejected them. Fix: `validate.js` now writes query results to a new property, `req.validatedQuery`, instead of trying to overwrite `req.query`. Body and route-param validation were unaffected — only `query` has this special getter behavior in Express 5.

**New concepts introduced**
- **DTO (Data Transfer Object)**: the shape of data crossing a boundary — an *input* DTO (zod schema) describes what a request body must look like; an *output* DTO (a mapper function) describes exactly what the API sends back, so a raw database row (with things like `passwordHash`) can never accidentally leak into a response.
- **Middleware factory**: a function that *returns* a middleware function, parameterized by whatever you pass in — `validate(createItemSchema)` and `validate(listItemsQuerySchema, 'query')` are two different middlewares built from the same factory.
- **Soft delete**: marking a row as deleted (`deletedAt` set) instead of removing it from the database — it disappears from every normal query (`deletedAt: null` filter) but the data still physically exists, recoverable later (export's `includeDeleted` option in Part 6 relies on this).

**You should be able to explain**
1. Why accessing another user's item returns 404 instead of 403, and what information a 403 would leak that a 404 doesn't.
2. What a "middleware factory" is, using `validate(schema)` as the example — why does `validate` need to be called before it can be used as middleware?
3. In your own words, what soft delete means and why `DELETE /items/:id` doesn't actually remove the row from the database.

## 2026-07-18 — Part 4: Scheduling logic (the heart of the app)

**What was built**
- `services/schedule.service.js`: three **pure functions** — `isDueOn`, `applyReview`, `applySkip` — that take plain data in (an item-shaped object, a date string) and return plain data out (the item's new stage/date, or a thrown `AppError`). No Prisma, no `req`/`res` anywhere in this file.
- `tests/schedule.test.js`: 14 focused unit tests against those pure functions directly — due/overdue/not-due/completed-never-due, all three stage advances (0→1, 1→2, 2→archived), interval counted from the completion date rather than the original due date, early-review rejection, archived-item rejection, same-day double-review rejection, and the skip-specific versions of those checks. All pass, no database involved.
- Three new endpoints, all going through the same layered stack: `GET /items/due?date=`, `POST /items/:id/review`, `POST /items/:id/skip`. The orchestration (fetch the item, call the pure function, persist the result) lives in `items.service.js`, which now delegates every rule decision to `schedule.service.js`.
- `prisma/seed.js` expanded: wipes and recreates the dev user's items every time it runs, anchored on whatever "today" the seed script's own clock says, covering every stage the spec calls for — due today at stage 0/1/2, overdue, not-yet-due, and a fully archived item with its 3-review history.
- Walked the entire lifecycle by hand against the seeded + a freshly created item: create → early-review-rejected → review (0→1) → skip (+1 day) → review (1→2) → review (2→archived) → re-review-rejected. Every date and stage number came out exactly as the 2-7-30 rule predicts.

**Key decisions and why**
- **The pure functions own the *rules*, not just the math.** `applyReview`/`applySkip` decide whether an action is allowed at all (throwing `AppError` for "not due" or "already archived") *and* compute the resulting state. This was a deliberate redesign from an earlier draft that only computed state transitions and left the rule-checking to the database-touching service — moving the rules into the pure layer is what makes "early review rejected" and "double review rejected" testable with zero database setup, which is exactly what build-plan.md's test list asked for.
- **No separate "is this a duplicate submission" check.** The due-check alone (`nextReviewDate <= date`) rejects a second review on the same day, because the first review already pushed `nextReviewDate` forward. One rule, two guarantees (no early reviews, no double-clicks) — this was call it out in build-plan.md and it held up exactly as described once built.
- **`review`/`skip` write two rows (a `Review` insert and an `Item` update) inside one `prisma.$transaction([...])`** — so a crash between the two calls can never leave a review recorded without the schedule advancing, or vice versa.

**Problems hit and how they were solved**
- **Vitest's own package can't be `require()`'d** — only the test file itself, not our application source. Vitest exposes `describe`/`it`/`expect` as an ESM-only export, so `tests/schedule.test.js` uses `import` while every file it imports (`schedule.service.js`, `dates.js`, etc.) stays CommonJS — Vite's transform layer bridges the two automatically.
- **A dual-module-identity gotcha**: an `expect(...).toThrow(AppError)` assertion failed even though the thrown error had exactly the right `message`/`status`/`code`. Reason: because the test file is ESM and `errorHandler.js` is CommonJS, the module loader ends up creating two separate copies of the `AppError` class — structurally identical, but different objects, so `instanceof` fails across that boundary. Fix: dropped the `instanceof`-based assertion and kept the `toThrow(expect.objectContaining({ status, code }))` one, which checks the actual behavior contract instead of class identity.

**New concepts introduced**
- **Pure function**: a function whose output depends only on its inputs, with no side effects (no database writes, no reading the clock, no HTTP). `schedule.service.js` is pure specifically so its rules can be tested by just calling it with fake data — no server, no database, no mocking required.
- **Database transaction**: a group of operations that either *all* succeed together or *all* fail together. Used here so a review is never recorded without the item's schedule actually advancing.

**You should be able to explain**
1. Why `schedule.service.js` has zero Prisma calls in it, and what that buys us when writing its tests.
2. How one single rule (`nextReviewDate <= date`) manages to prevent both "reviewing early" and "double-clicking review on the same item twice."
3. What would go wrong (concretely) if the review-insert and the item-update in `reviewItem` were two separate, non-transactional database calls instead of one `$transaction([...])`.
