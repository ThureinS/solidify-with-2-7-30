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
