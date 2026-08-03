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

## 2026-07-18 — Part 5: Auth, roles, and retiring the dev-user shortcut

**What was built**
- `src/lib/jwt.js`: thin wrapper around `jsonwebtoken` — `signToken({ userId, role })` (7-day expiry) and `verifyToken(token)`. Both read `JWT_SECRET` from `process.env` **at call time**, not as a top-level constant, so a missing secret fails loudly with a clear error instead of silently signing tokens with the string `"undefined"`.
- `src/services/auth.service.js`: `registerUser` hashes the password with bcrypt (cost 10) and creates the user (role defaults to `USER`). `loginUser` checks the password, returns the *same* 401 message/code whether the email doesn't exist or the password is wrong, checks suspension *after* the password check (so an unauthenticated caller can't learn "this account is suspended" without proving they know the password first), then signs and returns a JWT.
- `src/middleware/auth.js` (`requireAuth`): reads `Authorization: Bearer <token>`, verifies it, then **looks the user up in the database again** and checks `isSuspended` fresh — every request, not just at login. Sets `req.userId` and `req.user`. Now guards every item route (replacing `devUser`) and `GET /auth/me`.
- `src/middleware/isAdmin.js` (`requireAdmin`): 403s if `req.user.role !== 'ADMIN'`. Assumes `requireAuth` already ran.
- `src/middleware/authRateLimit.js`: `express-rate-limit`, 10 attempts / 15 min per IP, custom `handler` so a 429 still comes back in our standard `{ error: { message, code } }` shape. Applied **only** to `/auth/register` and `/auth/login` — not the whole `/auth` router — because `/auth/me` is a normal authenticated read that shouldn't share a brute-force budget with the actual attack surface.
- New endpoints: `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `GET /admin/users` (paginated), `POST /admin/users/:id/suspend`, `POST /admin/users/:id/unsuspend`.
- **Retired the dev-user shortcut**: deleted `src/lib/devUser.js` and `src/middleware/devUser.js` outright. `prisma/seed.js` now creates two real accounts with real bcrypt-hashed passwords — `demo@example.com` / `Demo1234` (owns the 6 test items) and `admin@example.com` / `Admin1234` (role `ADMIN`) — instead of one fixed dev user with a placeholder hash.
- Cleaned up the old dev-user's leftover row and its 6 original items/reviews directly in the local database — they were orphaned once the seed script switched from a fixed dev-user ID to looking up real users by email, and nothing in the app pointed at them anymore.
- Tested the entire flow by hand with curl: register (success, duplicate-email 409, weak-password 400), login (wrong password, unknown email — identical 401 either way — correct login), `/auth/me` with and without a token, item routes rejecting missing/garbage tokens, two different users only ever seeing their own items, non-admin hitting `/admin/users` (403), admin listing/suspending/unsuspending, an admin blocked from suspending themselves (403), a suspended user's **already-issued token** immediately rejected (proves the DB check works, not just login), suspended-user login rejected, and suspending a nonexistent user ID (404). All 14 existing scheduling tests still pass, untouched.

**Key decisions and why**
- **`requireAuth` re-fetches the user from the database on every request instead of trusting the JWT's contents.** A JWT is a sealed, tamper-proof snapshot from the moment it was signed — it has no way of knowing "this user got suspended 10 minutes ago." The spec explicitly requires that an existing token stop working the moment its owner is suspended, which is only possible with a fresh database check on every request. The cost is one extra query per authenticated request — accepted deliberately for real-time suspension enforcement.
- **Login returns only `{ token }`, not the user's details.** `GET /auth/me` is the dedicated place to fetch account info, so login's job stays simple, and `requireAuth` already has the full user row in hand by the time a controller needs it (no second query).
- **Same 401 message and code for "wrong password" and "unknown email."** Telling them apart would let an attacker enumerate which emails are registered accounts.
- **No dummy/constant-time bcrypt comparison on the "user not found" path.** A truly-missing user skips `bcrypt.compare` entirely, which is very slightly faster than a wrong-password attempt on a real account — a known timing side-channel. Left unmitigated as a deliberate trade-off consistent with this project's existing posture (client-supplied dates already trusted, no refresh tokens) — this is a personal tool, not a target worth the extra complexity for.
- **Rate limiter scoped to `/register` and `/login` only**, not the whole `/auth` router — see "what was built" above.
- **Self-suspend check lives directly in `admin.controller.js`**, not extracted into a shared/reusable function. It's a single `req.params.id === req.userId` comparison used in exactly one place — pulling it into its own module would be an abstraction with no second caller.

**Problems hit and how they were solved**
- **Stale data from the retired dev-user shortcut.** The old seed script always upserted the same fixed UUID; the new one looks up demo/admin users by email and generates fresh UUIDs. The wipe-and-reseed step only ever cleaned up rows belonging to the *current* demo user, so the original dev user's row and its 6 items/reviews were silently orphaned — still in the database, just no longer reachable through the app. Found this by literally reading the admin user list and noticing an extra `dev@example.com` row that didn't belong. Fixed by deleting those rows directly (reviews → items → user, in FK order) since they were dead test data from a shortcut we'd already decided to retire.
- **`z.string().email()` is deprecated in this Zod version** (flagged by the editor's type checker) — switched to the newer top-level `z.email()`, same validation, no functional change.

**New concepts introduced**
- **JWT (JSON Web Token)**: a signed, tamper-evident piece of text a server hands out at login. Anyone can read what's inside it, but nobody can change it without invalidating the signature — so the server trusts it *is* who it says it is, but the server still has to separately check whether that identity is still allowed to do anything (see the suspension design decision above).
- **bcrypt cost factor**: a dial on how many rounds of scrambling go into hashing a password. Higher costs slow down both real logins and brute-force guessing — cost 10 is a common default that's slow enough to matter to an attacker guessing millions of passwords, fast enough that a real user never notices.
- **Rate limiting**: capping how many times a client (identified by IP here) can hit an endpoint in a time window — the standard defense against brute-forcing a login form by trying thousands of passwords per second.
- **RBAC (role-based access control)**: deciding what a request is allowed to do based on a role (`USER` vs `ADMIN`) attached to the logged-in account, rather than every user having identical access.

**You should be able to explain**
1. Why `requireAuth` queries the database on every single request instead of just trusting the `userId`/`role` already inside the verified JWT.
2. Why a wrong password and an unknown email return the exact same 401 message and error code from `loginUser`.
3. Why the self-suspend check sits directly inside `admin.controller.js` instead of being pulled out into a reusable function somewhere.

## 2026-07-18 — Part 6: Docs, export, CI

**What was built**
- `openapi.yaml`: one hand-written OpenAPI 3.0 spec at the repo root covering every endpoint in the spec (health, auth, items, due/review/skip, export, admin) with one example request/response each, a shared `bearerAuth` security scheme, and reusable `components/schemas` (`AuthUser`, `ItemSummary`, `ItemDetail`, `Review`, `Error`) so the endpoint definitions don't repeat the same shape over and over.
- Wired it up with `swagger-ui-express` (renders an interactive, browsable API explorer from the spec) + `js-yaml` (parses the hand-written YAML into the JS object `swagger-ui-express` expects — Node has no built-in YAML parser) at `GET /api/v1/docs`.
- `GET /api/v1/export?includeDeleted=true|false` (default `false`): returns the logged-in user's own account info (via the same `toAuthUser` mapper already used by `/auth/me` and admin's user list — no new mapper needed, no password hash) plus every owned item with full text and review history, each item additionally tagged with a `status` field (`active` / `archived` / `deleted`) computed from `isComplete`/`deletedAt`. Soft-deleted items are included only when the flag is `true`.
- `.github/workflows/ci.yml`: a ~10-line GitHub Actions workflow that runs on every push and pull request — checkout, Node 22, `npm ci`, `npx prisma generate`, `npm test`. No Postgres service container, because nothing in the test suite talks to a real database (see below).
- `README.md`: what the app is, the 2-7-30 rule in three sentences, the full endpoint table, how to run it locally, a link to this journey log, and the "known trade-offs" section.
- Tested by hand: export excludes soft-deleted items by default (6 items), includes them when `includeDeleted=true` (still 6 total after soft-deleting one — 5 active/archived + 1 deleted), rejects a nonsense `includeDeleted` value with 400, and requires a real token like every other item-adjacent route. Confirmed `/api/v1/docs` actually renders (200, loads its init script) and that helmet's default Content-Security-Policy — which blocks the inline `<script>`/`<style>` tags Swagger UI needs — only applies there once relaxed, while every other route keeps the strict CSP untouched. Confirmed `npx prisma generate` succeeds with zero environment variables set (no `DATABASE_URL` needed — it only reads the schema file and writes generated code, no network call), and, by temporarily deleting the generated client, confirmed exactly what breaks without that CI step: `Error: Cannot find module '@prisma/client'`, thrown from `errorHandler.js` before a single test runs. All 14 scheduling tests still green throughout.

**Key decisions and why**
- **`includeDeleted` is validated as `z.enum(['true', 'false']).transform(v => v === 'true')`, not `z.coerce.boolean()`.** Verified directly: `z.coerce.boolean().parse('false')` returns `true`, because JavaScript's `Boolean(x)` only checks "is this an empty string," and `"false"` is a non-empty string. The enum+transform approach compares the literal text instead of relying on truthy/falsy coercion, and rejects anything that isn't exactly `"true"` or `"false"` with a 400 instead of silently guessing.
- **Export's per-item `status` field lives in a new `toExportItem` mapper in the existing `item.mappers.js`**, built by spreading `toItemDetail(item)` and adding one computed field — not a whole new DTO file, and not a change to `toItemDetail` itself (which is already used, unchanged, by `GET /items/:id`).
- **No Postgres service container in CI.** `tests/schedule.test.js` only exercises `schedule.service.js`, a pure function file with zero Prisma calls (established back in Part 4) — there is nothing for a database to do in this test run. `prisma generate` is still required, though, because `errorHandler.js` (imported transitively by the test file) does `require('@prisma/client')`, and that module doesn't exist until generated.
- **Swagger UI's route is mounted *before* the global `helmet()` line, not just given its own relaxed `helmet({ contentSecurityPolicy: false })` call.** Middleware runs top-to-bottom in file order; once the global strict `helmet()` had already set the CSP header, a second helmet call further down configured with `contentSecurityPolicy: false` could only choose not to *add* its own header — it had no way to erase one already set upstream. Moving the docs route (and its own relaxed helmet) ahead of the global one means Swagger UI's response goes out before the strict `helmet()` line is ever reached for that path; every other route still passes through the strict global instance exactly as before.

**Problems hit and how they were solved**
- **The CSP fix didn't work on the first try.** Adding `contentSecurityPolicy: false` to the docs-specific `helmet()` call alone left the strict CSP header in place (verified with `curl -I`, header still present). Root cause was middleware order, not the flag itself — see the decision above. Fixed by reordering `app.js` so the docs route (with its relaxed helmet) comes before the global strict `helmet()`, then re-verified with `curl -I` that `/docs` now has no CSP header while `/health` still does.

**New concepts introduced**
- **OpenAPI / Swagger**: a standard, machine-readable way to describe an HTTP API's endpoints, request/response shapes, and auth requirements in one file (`openapi.yaml` here); `swagger-ui-express` turns that file into an interactive webpage where every endpoint can be read about and tried directly in the browser.
- **CI (continuous integration)**: automatically running your test suite (and any other checks) on a clean machine every time code is pushed, so a broken change gets caught immediately instead of being discovered later — or by someone else.
- **Middleware execution order**: Express runs `app.use()`/route handlers in exactly the order they're registered in the file, for every matching request, until one of them sends a response — later middleware in the file never runs for a request that already got answered earlier.

**You should be able to explain**
1. Why `z.coerce.boolean()` would have been the wrong choice for parsing `?includeDeleted=false`, and what specifically goes wrong if you use it.
2. Why the CI workflow needs `npx prisma generate` but doesn't need to start a real Postgres database.
3. Why moving the `/api/v1/docs` route to before the global `helmet()` line fixed the Content-Security-Policy problem, when adding `contentSecurityPolicy: false` to the docs-specific helmet call alone did not.

**Correction to Part 6:** the exact error message quoted there (`Cannot find module '@prisma/client'`) came from a test that accidentally deleted the *entire* npm package, not just the generated output. The precise error when only `prisma generate` was skipped is `Cannot find module '.prisma/client/default'` — the raw npm package is still present (it's a normal dependency), only the schema-specific generated code inside it is missing. The conclusion is unchanged: something still has to trigger `generate` in every environment.

## 2026-07-18 — Part 7: Deployment (Neon + Vercel)

**What was built**
- Deployed live at **https://solidify-with-2-7-30-git-main-thureinss-projects.vercel.app**, backed by a real Neon Postgres database, via Vercel's Marketplace-managed Neon integration.
- `prisma.config.ts` now prefers `DATABASE_URL_UNPOOLED` for migrations, falling back to `DATABASE_URL` locally (Docker Postgres has no pooler, so this is a no-op change for local dev).
- `package.json`: added `"postinstall": "prisma generate"` and `"type": "commonjs"`. Removed the plan's originally-suggested `"vercel-build"` script name in favor of the more standard `postinstall`, which fires on every `npm install`/`npm ci` everywhere (laptop, CI, Vercel) rather than only on Vercel.
- **No `api/index.js` or `vercel.json` needed** — checked Vercel's current official docs (dated 2026-07-06) and found Express now gets zero-config detection: Vercel auto-detects an Express app exported via `module.exports = app` at one of six conventional file locations, and `src/app.js` already matches exactly. Wrote `api/index.js` initially (following `build-plan.md`'s original plan), then deleted it once this was confirmed.
- Simplified `.github/workflows/ci.yml` from 3 run-steps to 2, since `postinstall` now makes the explicit `npx prisma generate` step redundant — verified by actually running `npm ci` after deleting the generated client and confirming it regenerates automatically.
- `.env.example` and `README.md` updated: documented `DATABASE_URL_UNPOOLED` (production/migrations only), added a "Deploying (Neon + Vercel)" section with the exact steps, and an explicit post-deploy instruction to *open* `/api/v1/docs` in a browser rather than trust a `curl` 200.
- Full live verification, walked end-to-end with curl against the deployed URL: health check, register, login, `/auth/me`, create an item, create a backdated item that's due today, confirm it appears in the due queue, review it (stage 0→1, `nextReviewDate` correctly advanced +7 days from the completion date), confirm a same-day re-review is rejected with 409, and confirmed Swagger UI at `/api/v1/docs` actually renders — not just a 200 on the HTML, but the real HTML content plus 200s on `swagger-ui.css`, `swagger-ui-bundle.js`, and `swagger-ui-init.js` specifically (the static-asset risk flagged going in, which turned out fine here, but was worth checking rather than assuming).

**Key decisions and why**
- **Vercel-managed Neon integration** (creates the Neon account/project automatically from inside Vercel) over a separate manual Neon signup — one account instead of two, env vars auto-injected instead of manually copy-pasted.
- **Turned off Neon's "Auth" add-on** during setup — we already built our own JWT + bcrypt auth system in Part 5; enabling Neon's would have provisioned extra unused tables/resources.
- **Left "Create database branch for deployment" unchecked** for both Production and Preview — that's Neon's branch-per-deployment feature, unnecessary complexity for a single personal-project database.

**Problems hit and how they were solved**
- **`build-plan.md`'s Part 7 design was outdated on three separate points**, each caught by checking current docs/behavior instead of trusting the plan as written: (1) Vercel no longer needs `api/index.js` + `vercel.json` for a standard Express app — zero-config detection now handles it; (2) `"vercel-build": "prisma generate"` is superseded by the more standard `"postinstall": "prisma generate"`, confirmed against current Prisma docs; (3) the plan said "pooled connection string" for production without mentioning that Prisma Migrate specifically needs the *direct* one — surfaced by actually reading what environment variables the Neon integration provides (both `DATABASE_URL` and `DATABASE_URL_UNPOOLED`) rather than assuming one string would do both jobs.
- **Vercel's dashboard would not let the direct connection string be copied** ("Sensitive environment variables cannot be copied") — a real security feature (write-only value, not viewable even by the project owner through Vercel's UI). Worked around it via Neon's *own* console (reachable from Vercel's Storage tab), which doesn't have this restriction, rather than the more roundabout `vercel env pull`/`vercel env run` CLI dance considered first.
- **Pasted a live database connection string (including its real password) directly into chat** while working through the above — flagged immediately as an exposure, with a follow-up recommendation to reset that database's password in Neon afterward, independent of getting the migration to run.
- **The live URL returned a 302 redirect to `vercel.com/sso-api`** instead of the API response — Vercel's "Deployment Protection" (Vercel Authentication, "Standard Protection") was on by default, requiring visitors to be logged into the Vercel team to view any deployment, including Production. This would have silently blocked anyone without a Vercel account — including a course grader — from ever reaching the API. Fixed by turning off "Require Log In" in Project Settings → Deployment Protection.

**New concepts introduced**
- **Connection pooling (PgBouncer)**: many short-lived database connections sharing a small number of real, already-open connections underneath — good for a serverless app that might spin up many function instances quickly, but the shared/transaction-mode pooling model doesn't support the session-level locks Prisma Migrate needs while changing table structure. Hence two different connection strings for two different jobs.
- **npm lifecycle scripts** (`postinstall` specifically): a small set of *reserved* script names that npm runs automatically at specific moments (right after `npm install`/`npm ci` finishes, in this case) — different from every other script in `package.json`, which only runs when someone explicitly types `npm run <name>`.
- **Zero-config framework detection**: Vercel inspecting a repo for known conventional patterns (e.g. an Express app exported from one of six standard file locations) and wiring up the deployment automatically, without a hand-written `vercel.json`.
- **Deployment Protection / Vercel Authentication**: a project-level setting (separate from anything in application code) that gates an entire deployment behind a login wall — worth checking explicitly, since a passing `curl` test against a URL that should be public can instead mean the request never reached the app at all.

**You should be able to explain**
1. Why production needs two different database connection strings (`DATABASE_URL` and `DATABASE_URL_UNPOOLED`) when local development only ever used one.
2. What `"postinstall": "prisma generate"` actually means — when does it run, and why is that a better fit here than a platform-specific script name like `"vercel-build"`?
3. Why a `200` status code on `/api/v1/docs` wasn't, by itself, proof that Swagger UI was working correctly — what else had to be checked, and why?

## 2026-07-18 — Bonus: minimal React frontend + CORS

Not part of the original course spec — `submission-requirements.md` explicitly backlogs "the frontend UI." Built and deployed anyway, by request, kept isolated so the backend stays a clean, self-contained course deliverable on its own.

**What was built**
- **CORS support on the backend** (`cors` package, `CORS_ORIGIN` env var, comma-separated allowlist defaulting to the Vite dev server's port). The API previously sent no CORS headers at all, which would silently block every `fetch()` from a browser on a different origin — this had to land on the already-deployed, already-"done" backend before any frontend work could talk to it.
- **`frontend/`**: a Vite + React app, isolated with its own `package.json`, not wired into the backend's CI or deploy. Three files hold essentially the whole app: `api.js` (a small `fetch` wrapper, one function per endpoint used), `AuthForm.jsx` (login/register, toggled by one piece of state), `Dashboard.jsx` (add-item form + due-today list with Review/Skip buttons). `App.jsx` just decides which of the two to show, based on whether a JWT exists.
- Scope deliberately kept to the core loop only: register/login → store token → add an item → see what's due → review/skip it. Editing, deleting, export, and the entire admin surface are left backend-only (reachable via Swagger) — a beginner shouldn't build UI for 16 endpoints in one sitting when 5 already tell the whole story.
- **Deployed as its own separate Vercel project**, root directory set to `frontend/`, `VITE_API_URL` set at build time (Vite bakes `VITE_`-prefixed env vars into the bundle during `vite build` — this can't be changed after the fact without rebuilding). Turned off Deployment Protection on this new project too, same as the backend.
- Verified twice with a real browser (via Playwright, not just curl): once locally (register → auto-login → add item → log out → log back in as the seeded demo user → due queue renders with correct stage labels → Review correctly removes the item from the queue, zero console errors) and once again fully deployed (frontend's own Vercel URL calling the backend's own Vercel URL, register → auto-login → add item, zero *new* console errors).

**Key decisions and why**
- **`localStorage` for the JWT**, not an in-memory-only variable. Simplest option — survives a page refresh — consistent with this project's existing risk posture (client-trusted dates, no refresh tokens, all previously accepted for the same reason: this is a personal tool, not a high-value target). A more secure httpOnly-cookie-based approach would need backend changes to issue/read cookies instead of a bearer token, which is real added scope for marginal benefit here.
- **The frontend computes "today" from the browser's local date components** (`getFullYear`/`getMonth`/`getDate`), not `toISOString().slice(0,10)`. The backend was built entirely around trusting the client's date — `new Date().toISOString()` gives the *UTC* date, which is a day off from the user's actual calendar date near midnight in most timezones. Using the local components is the frontend's half of the same timezone-safety concern the backend's `lib/dates.js` was designed around from Part 2 onward.
- **Two separate Vercel projects (backend and frontend), not one combined deployment.** Keeps the backend a clean, independent, gradeable artifact; the frontend is explicitly bonus and can be deleted or ignored without touching the backend at all.

**Problems hit and how they were solved**
- **Logging in with the seeded `demo@example.com` account failed on the deployed frontend** (`401 Invalid email or password`) even though CORS was confirmed fixed. Not a bug: that account only ever existed in the *local* Docker Postgres database (created by `npm run seed`, which was never run against the production Neon database — only `prisma migrate deploy` was, deliberately, to create the schema without seeding fake data into production). Resolved by registering a fresh account directly against the deployed frontend instead, which worked immediately.
- **The first deploy of the frontend hit the exact same CORS block it was built to avoid** — expected, since the backend's `CORS_ORIGIN` only had `localhost:5173` in it at that point. Confirmed the exact failure in the browser console (`No 'Access-Control-Allow-Origin' header is present`), added the new frontend's deployed URL to the backend's `CORS_ORIGIN`, redeployed the backend, and re-verified in the browser that the same login attempt then succeeded with zero CORS errors.

**New concepts introduced**
- **CORS (Cross-Origin Resource Sharing)**: the browser's own security rule that blocks a page from `fetch()`-ing a different origin (different domain, subdomain, or port) unless that other server explicitly says "requests from your origin are allowed" via response headers. It's enforced by the *browser*, not the server — `curl` never triggers or respects it at all, which is exactly why this had to be tested in a real browser to catch.
- **Vite env var baking**: variables prefixed `VITE_` get compiled directly into the JavaScript bundle at `vite build` time, not read fresh at runtime like a backend's `process.env`. Changing one after deploying requires a full rebuild, not just an environment variable edit.

**You should be able to explain**
1. Why the CORS error only showed up in a real browser and never in any of the `curl` testing used throughout the rest of this project.
2. Why the frontend computes "today" from `getFullYear`/`getMonth`/`getDate` instead of `new Date().toISOString().slice(0, 10)`, and what would go wrong near midnight if it didn't.
3. Why logging into the deployed frontend with the local seed script's `demo@example.com` account failed, and what that reveals about the difference between the local and production databases.

## 2026-07-20 — Bonus: "All items" list view + visual reskin

Started from a gap analysis: comparing every backend endpoint against what the frontend actually calls. Out of 14 endpoints, only 6 were wired up (register, login, create item, due queue, review, skip) — the rest (full item list, item detail, edit, delete, admin panel, export, `/auth/me`) had no UI at all. Asked for a full list view specifically, since there was no way to see anything besides today's due queue.

**What was built**
- **"All items" tab** in `Dashboard.jsx`, alongside the existing "Due today" tab. Calls `GET /items` (already built on the backend, just never called from the frontend) with a status filter (Active / Archived / All) and Prev/Next pagination. `frontend/src/api.js` got one new function, `listItems(token, { status, page })`.
- **Visual reskin** of the whole frontend (`App.css`, `index.css`), inspired by the visual language of withnovu.com (a marketing site) — not a literal copy, since that site's actual content (hero photo, testimonials, FAQ accordion) doesn't apply to a functional CRUD dashboard. What carried over: a warm off-white background, near-black text, one terracotta accent color used consistently for primary actions, big soft-radius cards replacing the old hairline-bordered list rows, and more generous whitespace.

**Key decisions and why**
- **CSS custom properties** (`--color-accent`, `--color-bg`, etc.) defined once in `index.css`'s `:root`, referenced everywhere else with `var(--color-accent)`. Changing the accent color is a one-line edit instead of hunting through every button/border rule.
- **Light-only, not light+dark.** The old `index.css` had `color-scheme: light dark`, which let the browser auto-invert form controls in dark mode — but nothing was actually *designed* for dark mode, so it was accidental behavior, not a real feature. Dropped it rather than build a second palette for a bonus learning project.
- **Edit, delete, admin panel, and export were deliberately left out of this pass.** You asked specifically to fix "I can't find my full list" — adding a full CRUD/admin surface on top of that would have been scope creep beyond what was asked. They're still open gaps, listed below.

**Problems hit and how they were solved**
- **Local Postgres wasn't running** (Docker Desktop itself was closed), so the due-list API calls failed with `ECONNREFUSED` when testing in the browser. Fixed by starting Docker Desktop and running `docker compose up -d` for the project's `db` container.
- **Styling the active vs. inactive tab** without changing any JSX logic. `Dashboard.jsx`'s tab buttons don't have a dedicated "active" class — the inactive tab renders `<button className="secondary">`, the active one renders a plain `<button>` with no class at all. Solved with CSS specificity: `.tabs button` styles the active (unclassed) button, `.tabs button.secondary` (two classes, so it wins) overrides it for the inactive one — no new component state needed.

**New concepts introduced**
- **CSS custom properties (CSS variables)**: a named value (e.g. `--color-accent: #c1662b`) defined once and reused anywhere with `var(--color-accent)`. Distinct from Sass/Less variables — these are real, live values the browser resolves at render time.
- **CSS specificity**: the browser's rule for which of several matching CSS rules wins when they conflict. More/narrower selectors (two classes) beat fewer/broader ones (one class), regardless of which rule appears later in the file — this is what let the tab styling work without touching `Dashboard.jsx`'s logic.

**You should be able to explain**
1. What does the `status` query param on `GET /items` do, and what's the difference between `active`, `archived`, and `all`?
2. Why does changing one line (`--color-accent`) in `index.css` update the Add Item button, the active tab underline, and the Review button all at once?
3. Why did styling the active/inactive tabs need `.tabs button.secondary` as a selector instead of adding an `.active` class in the JSX — what does that say about how the two tab buttons are actually rendered?

## 2026-07-21 — Bonus: item detail, edit, and soft-delete

This turned the "All items" list from read-only into something you can actually manage. It wires three backend endpoints that had no UI: `GET /items/:id` (detail), `PATCH /items/:id` (edit text), and `DELETE /items/:id` (soft delete). That takes the frontend from 8 of 14 endpoints to 11 of 14 — remaining gaps: the admin panel and export.

**What was built**
- **`api.js`** got three new functions: `getItem`, `updateItem`, `deleteItem`. All three ride the existing generic `request()` helper — because that helper already returns `null` on a `204 No Content` response, `deleteItem` needed no special-casing at all.
- **`ItemDetail.jsx`** (new component, following the existing one-file-per-screen pattern of `AuthForm` / `Dashboard`): loads a single item, shows its full text + status line (stage, date added, next review) + review history, and has inline **Edit** (a textarea that saves via PATCH) and **Delete** buttons plus a **Back** link.
- **`Dashboard.jsx`**: the "All items" rows are now clickable — clicking one sets a `selectedId` state, and while that's set the dashboard renders `<ItemDetail>` instead of the list. After an edit or delete, the list re-fetches so previews stay fresh.
- **`App.css`**: a handful of additions, all reusing the existing design tokens — a clickable-row hover cue, a `textarea` style, and a `button.danger` variant (terracotta's cousin: uses `--color-error`).

**Key decisions and why**
- **Detail view is a full-screen swap, not a modal.** When `selectedId` is set, `Dashboard` early-returns `<ItemDetail>` and the list/header disappear. A modal overlay would have meant managing focus traps and backdrop clicks — more machinery than a bonus screen needs. The detail view has its own Back button, so nothing is lost.
- **`window.confirm` for the delete confirmation** (this was your call to make). Delete is destructive from the user's point of view, so a bare click is dangerous — one misclick wipes a card. `window.confirm` prevents that with zero extra state or markup. The trade-off is it's a plain browser dialog, not on-brand; the noted upgrade path is an inline two-step "click again to confirm" button if that ever matters.
- **Editing text does NOT touch the schedule.** The backend's `updateItemText` only changes the text field — stage and next-review date stay put. Verified this in the DB after an edit: text changed, `nextReviewDate` unchanged. Editing a typo shouldn't reset your review timing.
- **Clickable `<li>` rows are keyboard-accessible.** A `<li>` isn't a button, so mouse-only `onClick` would strand keyboard users. Added `role="button"`, `tabIndex={0}`, and an `onKeyDown` that fires on Enter/Space — the accessibility basics that make a non-button element behave like one.

**Problems hit and how they were solved**
- **Docker Desktop was closed again**, so local Postgres was down. Started it (`open -a Docker`, waited for the daemon), then `docker compose up -d` and `prisma migrate deploy` before the backend would connect.
- **Verifying "soft" delete, not just "gone."** The UI hides deleted items even under the "All" filter, so the list disappearing isn't proof the row survived. Confirmed by querying Postgres directly: the deleted item's row is still there with `deletedAt` set (`deleted = t`) and its edited text intact — a real soft delete, recoverable via export's `includeDeleted`.

**New concepts introduced**
- **Soft delete**: instead of removing a row, you stamp a `deletedAt` timestamp and filter those rows out of normal queries. The data survives (auditable, restorable); it just stops showing up. The opposite is a "hard delete" (`DELETE FROM ...`), which is irreversible.
- **`204 No Content`**: an HTTP status meaning "success, and there's no body to send back." Delete endpoints use it because there's nothing meaningful to return. The frontend's `request()` helper checks for 204 and resolves to `null` instead of trying to parse an empty body as JSON (which would throw).
- **Accessible name / `role`**: assistive tech decides what an element *is* from its `role` and how to announce it from its accessible name. Giving a `<li>` `role="button"` + keyboard handling makes it announce and behave as a button despite not being one.

**You should be able to explain**
1. When you delete an item, the row vanishes from every filter in the UI — so how do we actually know it was a *soft* delete and not permanently destroyed?
2. Why did `deleteItem` in `api.js` need no special code to handle the server's response, when `getItem` and `updateItem` both return JSON?
3. Clicking an "All items" row opens the detail view — what one piece of state in `Dashboard.jsx` makes that happen, and what makes the row work for someone navigating by keyboard instead of mouse?

## 2026-07-21 — Bonus: admin panel (users list + suspend/unsuspend) + /auth/me

Wired the admin surface into the frontend: an ADMIN-only tab listing all users with per-row Suspend/Unsuspend, plus the previously-unused `GET /auth/me`. This takes the frontend to 13 of 14 endpoints — **only `GET /export` remains**. We ran this slice through the full **feature-dev process** (a structured 7-phase workflow: discovery → codebase exploration → clarifying questions → architecture design → implementation → quality review → summary), using subagents to explore the code, propose architectures, and review the result. That's heavier than the last slice on purpose — it's the process itself we were practicing.

**What was built**
- **`api.js`**: `getMe`, `listUsers`, `suspendUser`, `unsuspendUser` (the last two POST and return 204 → `null`, like `deleteItem`). Also: the shared `request()` helper now attaches `err.status` to the error it throws, so callers can tell an auth failure (401/403) from a server blip.
- **`App.jsx`**: fetches `GET /auth/me` in a `useEffect` keyed on `[token]` (covers both first load and just-after-login with one effect), stores the `user`, and passes it down. This is how the client learns its own role and id.
- **`Dashboard.jsx`**: an "Admin" tab that renders only when `user?.role === 'ADMIN'`; a third `view` value (`'admin'`); the add-item form is hidden in the admin view.
- **`AdminPanel.jsx`** (new screen): paginated users list, each row showing email + `role · Active/Suspended · joined date`, with a Suspend (danger) or Unsuspend (secondary) button — **hidden on your own row** because the backend forbids self-suspend.
- **`Pagination.jsx`** (new): the Prev/"Page X of Y"/Next block, extracted from Dashboard and now shared by both the items list and the users list.
- **No new CSS, no new dependencies** — every style reused from the existing tokens/classes.

**Key decisions and why**
- **Client role-checks are cosmetic; the server is the real gate.** Hiding the Admin tab from non-admins is a convenience only — a non-admin who calls `/admin/*` directly still gets a 403 from the `requireAdmin` middleware. We stated this plainly in the code so it isn't mistaken for actual access control.
- **Fetch `/auth/me` instead of decoding the JWT client-side.** The token *does* contain the role, but `/auth/me` reflects live server state (a mid-session suspension shows up), gives a natural place to react to an expired token, and avoids a second source of truth. Cost: one extra request and a brief "role unknown" window (handled by `user` starting `null`, so the tab just appears a beat later).
- **Extracted `<Pagination>` but nothing else.** Two identical call sites is the "rule of two" — real duplication worth removing. We deliberately did *not* build a `usePaginatedList` hook or an auth Context (both would be premature at two call sites / two prop-drill hops); all three architecture agents independently agreed.
- **No confirm on Suspend.** Unlike item Delete (a one-way soft delete, which uses `window.confirm`), suspend is reversible via Unsuspend, so a confirm dialog would be friction for no safety gain.
- **Logout only on 401/403, not on any error.** Our first version logged out on *any* `/auth/me` failure — which would kick a user with a valid token out on a transient 500 or a dropped connection. Fixed to log out only when the status is 401/403 (session genuinely over) and otherwise keep the token.

**Problems hit and how they were solved**
- **Two edge-case bugs the happy-path test missed**, both found by a code-review agent after the feature visibly "worked":
  1. *Transient failure logged you out.* The `request()` helper threw a status-less `Error`, so `App.jsx` couldn't tell "token expired" from "server blip" and logged out on both. Fixed by attaching `err.status` and branching on 401/403.
  2. *Stale-response race.* On a fast logout→login, a slow `getMe` for the old token could resolve last and overwrite `user` with the previous person's data (a phantom Admin tab). Fixed with the standard effect-cleanup guard: a `let cancelled = false` flag flipped in the effect's cleanup function, checked before calling `setUser`.
- **Verifying suspend was real, not just a UI flip.** Confirmed the round-trip (Suspend → Unsuspend) against Postgres directly: `isSuspended` went `f → t → f`. Also verified the auto-logout branch by corrupting the stored token to force a 401 → the app dropped to the login screen and cleared the token.

**New concepts introduced**
- **`useEffect` cleanup for out-of-order async**: an effect can return a function that React runs before the next effect (or on unmount). Setting a `cancelled` flag there and checking it before applying an async result is the standard way to ignore a stale response when the input changed mid-flight.
- **Attaching data to an `Error`**: JS errors are plain objects, so you can set `err.status = ...` before throwing. Callers then branch on it — cleaner than string-matching the message.
- **Cosmetic gate vs. real authorization**: hiding UI by role improves UX but is not security. Authorization must be enforced server-side; the client check is only there so users don't see buttons they can't use.
- **JWT expiry with no refresh token**: the 7-day token, once expired, has no silent renewal path by design — the user simply logs in again to mint a fresh one.

**You should be able to explain**
1. Why is hiding the Admin tab from non-admins *not* a security measure, and where does the actual access control live?
2. We chose to fetch `/auth/me` rather than read the role out of the JWT the client already has. Give one concrete reason that's better.
3. Our first `/auth/me` code logged the user out on *any* failure. Why was that wrong, and what does the fixed version check before logging out?

**Answers + analogies (for rereading later)**
1. *What actually keeps a non-admin out of `/admin/users`?* The **server middleware** (`requireAuth, requireAdmin` in `src/routes/admin.routes.js`), not the hidden tab. Analogy: a nightclub. The **bouncer at the VIP door** = the middleware; **leaving "VIP" off the public map** = hiding the Admin tab. Not printing it on the map stops nobody — someone who knows the door is there can still walk up, and the bouncer turns them away. Concretely: a regular user can open the browser console and `fetch('/api/v1/admin/users')` directly; the server returns **403** regardless of what the UI showed. Hiding the tab is *cosmetic UX* (don't show buttons that would fail), never authorization.
2. *Why fetch `/auth/me` instead of reading the role from the JWT the browser already has?* Because a **JWT is a frozen snapshot from login time** — it can't update itself. Example: admin Alice logs in (token says `role: ADMIN`). Another admin then **suspends** Alice. Her token *still says* ADMIN / not-suspended, so trusting it would keep showing her the Admin tab. `/auth/me` asks the server for the **live current state**, which returns suspended → 401/403 → logout. Token = stale snapshot; `/auth/me` = current truth. (Also: no client-side decode code, and one source of truth.)
3. *Why was "logout on any failure" wrong, and what does the fix check?* The client reacts to the **HTTP status of the failed `/auth/me` request** (401/403 = session genuinely over → logout; 5xx / offline = transient → keep the token), not to the token's contents. Related: when a token *expires*, there's no refresh token by design (7-day JWT), so the user simply **logs in again** to get a fresh one.

## 2026-07-21 — Bonus: export slice (Download my items) — frontend now 14/14

Wired the last unused backend endpoint, `GET /export`, into the UI: an **Include deleted** checkbox + a **Download my items** button on the "All items" view. The frontend now exercises **all 14 backend endpoints**. Small slice, so we skipped the heavy feature-dev process and worked lean.

**What was built**
- **`api.js`**: `exportData(token, includeDeleted = false)` — a one-liner that calls `GET /export?includeDeleted=...` through the same `request()` helper as every other call.
- **`Dashboard.jsx`**: an `includeDeleted` piece of state, a `handleExport()` that fetches the JSON and saves it as a file, and the checkbox + button placed next to the existing Status filter.
- **`App.css`**: a small `.all-toolbar` flex row (filter left, export controls right) and inline-checkbox styling. No new colors, no new dependencies.

**Key decisions and why**
- **Reused `request()` instead of a separate file-download fetch.** The instinct with a "download" is that you need a special binary path (a `blob()` response, a streamed file). But `GET /export` doesn't stream a file — the backend just does `res.json({ user, items })`, plain JSON with **no `Content-Disposition` header**. So the ordinary helper that parses JSON is exactly right; the "download" is a *client-side* step, not a server one.
- **The download is Blob + a temporary `<a download>`.** We take the parsed object, `JSON.stringify` it, wrap it in a `Blob`, make a temporary object URL, create an off-screen `<a>` with a `download` filename (`my-items-YYYY-MM-DD.json`), `.click()` it, then revoke the URL. This is the standard browser "save this data as a file" pattern — the server returned data, the browser does the saving.
- **`includeDeleted` is sent as the literal string `'true'`/`'false'`.** The backend schema is a two-value enum (`z.enum(['true','false'])`), *deliberately* not `z.coerce.boolean()` — because `Boolean("false")` is `true` in JS (any non-empty string is truthy), which would be a silent foot-gun. So the client sends the exact strings the enum expects.
- **Placement + toggle were your calls:** control on the All items view (thematically "your items," already hosts filter controls), and the deleted option exposed as a checkbox so the feature is visible rather than hidden.

**Problems hit and how they were solved**
- **A checkbox styled like a giant text box.** The global `input, select, textarea` CSS rule (padding, border, radius) also hit the new checkbox and made it look wrong. Fixed with a scoped `.export-controls input[type='checkbox']` override (small fixed size, no padding, `accent-color: var(--color-accent)`), so the checkbox stays a checkbox and still uses the brand terracotta.
- **DB table names aren't the Prisma model names.** Cleaning up test data, `DELETE FROM "Item"` failed — the actual Postgres tables are lowercase plural (`items`, `reviews`, `users`) because the Prisma schema maps them with `@@map`. Worth remembering for any direct `psql` work.

**How we verified (end-to-end)**
- Backend via `curl`: no token → **401**; with token → JSON `{ user, items }`; created two items and soft-deleted one, then `includeDeleted=false` returned **1** item and `includeDeleted=true` returned **2**.
- UI via Playwright: the control renders on-brand next to the Status filter; clicking Download produced `my-items-2026-07-21.json`; **unchecked → 1 item** in the file, **checked → 2 items** (the soft-deleted one included), each item carrying its `reviews`.
- Cleaned the two test items out of Postgres afterward so the seeded admin is back to 0 items.

**New concepts introduced**
- **Blob**: an in-memory bag of bytes with a MIME type (here `application/json`). It's how the browser represents "a file's worth of data" that didn't come from disk.
- **Object URL** (`URL.createObjectURL` / `revokeObjectURL`): a short-lived `blob:` URL pointing at that in-memory Blob so an `<a>` or `<img>` can reference it. You `revoke` it when done to free the memory — otherwise it lives until the page unloads.
- **The `download` attribute**: on an `<a>`, it tells the browser "save the target instead of navigating to it," and its value becomes the suggested filename.
- **Why a JSON export needs no `Content-Disposition`**: that header is how a *server* tells the browser "treat my response as a download." Since our server returns plain JSON for the app to use, the client decides to save it instead — so the header isn't needed here.

**You should be able to explain**
1. `GET /export` returns JSON, yet we call it "download my items." Where does the actual *file* get created — on the server or in the browser — and which few lines do it?
2. Why could we reuse the same `request()` helper for export when the task warned that file downloads "likely need a different path"? What about *this* endpoint makes the ordinary helper fine?
3. The backend validates `includeDeleted` with `z.enum(['true','false'])` rather than `z.coerce.boolean()`. What bug does that avoid, and what must the client therefore send in the query string?

## 2026-07-22 — Backend: Redis in Docker (infrastructure + connectivity proof)

First of the remaining backend tasks. Stood up **Redis** as a Docker service and proved the API can talk to it. Important framing: this slice *only stands up the infrastructure* — nothing uses Redis yet. The actual use (a BullMQ email queue) is the next task; you don't build the queue until the thing it runs on exists. Low-complexity slice, built lean (no subagents).

**What Redis is (one line):** an in-memory key-value store — extremely fast because data lives in RAM, used here as the backing store for a background job queue (and later a refresh-token store).

**What was built**
- **`docker-compose.yml`**: a `redis:7-alpine` service (port 6379, `redis_data` volume so queued jobs survive a restart later). Alpine = a tiny Linux base image, so the download is small.
- **`.env` / `.env.example`**: `REDIS_URL="redis://localhost:6379"`, with a note that prod (Vercel) has no Redis and would need a managed one (Upstash).
- **`src/lib/redis.js`**: an `ioredis` client using the *same global-singleton pattern as `prisma.js`* (one connection, not a fresh one per hot-reload).
- **`/api/v1/health`**: now `async`, pings Redis and returns `{ status: 'ok', redis: 'up' | 'down' }` — so the connection is demonstrable with a single `curl`.

**Key decisions and why**
- **`ioredis`, not `node-redis`.** Both are solid Redis clients. Picked ioredis because the next task's queue library, **BullMQ, is built on ioredis** — so one client library serves both instead of two.
- **An `error` listener on the client is not optional.** ioredis emits an `'error'` event when Redis is unreachable, and a Node EventEmitter with no `'error'` listener *throws* — which would crash the entire API on a Redis blip. The listener logs instead, so the app stays up (it just can't queue jobs until Redis returns). Verified by stopping Redis: the API kept serving.
- **`enableOfflineQueue: false`.** This was a fix, not a first guess (see below).
- **Health check as the proof.** Rather than a throwaway script, the connectivity check lives in the existing `/health` endpoint — permanent, and useful for real monitoring later.
- **Guard against a Redis-less production.** This backend auto-deploys to Vercel on push to `main` (the live URL is `...git-main-...vercel.app`), and prod has no Redis. So if `REDIS_URL` is unset, `src/lib/redis.js` exports `null` instead of a client — otherwise the client would loop reconnect errors against a server that isn't there, and `/health` would show a misleading `redis:"down"`. With the guard, prod reports `redis:"not-configured"` and stays quiet. (Local testing alone can't catch this — it only shows up where the env differs from your machine.)

**Problems hit and how they were solved**
- **The health check hung when Redis was down.** First version pinged Redis with ioredis's defaults; with Redis stopped, `curl /health` didn't return `redis: "down"` — it *hung* past 15 s. Cause: ioredis's **offline queue** buffers commands while disconnected and waits for a reconnect, so `ping()` never rejected. A health check that hangs exactly when a dependency is down is useless (that's the moment you're asking it). Fixed with `enableOfflineQueue: false`, which makes commands reject immediately when disconnected. Re-tested: `redis: "down"` now returns in ~15 ms. (The original "waits a beat" code comment was empirically wrong and was corrected.)

**How we verified (end-to-end)**
- `docker compose up -d` → `docker compose exec redis redis-cli ping` → **PONG**.
- API up + Redis up → `/health` = `{"status":"ok","redis":"up"}`.
- **Stopped Redis** → API process stayed alive (didn't crash) and `/health` = `redis:"down"` in ~15 ms.
- **Restarted Redis** → `/health` = `redis:"up"` again (auto-reconnect).

**New concepts introduced**
- **Redis**: in-memory key-value store; here, the backend for a job queue.
- **Health / readiness check**: a lightweight endpoint that reports whether the app and its dependencies are reachable, for load balancers and monitoring. Key rule: it must **fail fast**, never hang.
- **ioredis offline queue**: by default ioredis buffers commands issued while disconnected and replays them on reconnect. Convenient for app writes; wrong for a health probe — hence `enableOfflineQueue: false`.
- **Unhandled `'error'` events crash Node**: an EventEmitter (like a Redis client) with no `'error'` listener re-throws the error, taking the process down. Always attach one on long-lived connections.
- **Alpine image**: a minimal Linux base for containers → smaller images, faster pulls.

**You should be able to explain**
1. We added Redis but nothing in the app uses it yet — so what does this slice actually accomplish, and why build it before the email queue?
2. If Redis goes down, why doesn't the whole API crash — what one line prevents that, and what breaks instead?
3. Our first `/health` hung when Redis was down. Why did it hang, and what setting made it report `"down"` quickly instead?

## 2026-07-22 — Backend: producer-consumer email queue (BullMQ + nodemailer), Docker-only

The instructor assignment: a background job queue. Scope kept tight to **welcome email on register only** — no due-date reminder scheduler. Ran this through feature-dev's earlier phases last session (exploration, clarifying questions) with every decision locked before this session started; this session was pure implementation + verification, with a lean architecture summary instead of a full architect-agent pass (your call — the design was already fully determined).

**The pattern in one line:** a "producer" (the register endpoint) drops a small job onto a Redis-backed queue and returns immediately; a completely separate, long-running "consumer" process (`worker.js`) picks jobs off that queue and does the slow part (talking to Gmail's SMTP server) on its own time. The two never call each other directly — Redis is the only thing connecting them.

**What was built**
- **`npm install bullmq nodemailer`** — BullMQ is the queue library (built on Redis/ioredis, which we already had from the last slice); nodemailer is the library that actually knows how to send an email over SMTP.
- **`src/lib/emailQueue.js`**: exports a BullMQ `Queue` named `'emails'` (or `null` if `REDIS_URL` isn't set — same prod-safety guard as `redis.js`). Deliberately uses its **own** ioredis connection instead of reusing `redis.js`'s singleton, because BullMQ needs different connection options (`maxRetriesPerRequest: null`, and it must NOT have `enableOfflineQueue: false` — that flag is right for a fail-fast health check, wrong for a queue, which should buffer jobs through a short Redis blip, not drop them). Default job options: 3 retries with exponential backoff, `removeOnComplete` (finished jobs don't pile up), `removeOnFail: false` (failed jobs stay visible for debugging).
- **Producer** — `src/services/auth.service.js`'s `registerUser`: after `prisma.user.create` resolves, a guarded fire-and-forget `emailQueue.add('welcome', { userId, email }).catch(console.error)`. Never `await`ed inline — a queue/Redis failure must never turn a successful signup into a 500.
- **Consumer** — new `worker.js` at the repo root (its own process, not part of the Express app): a BullMQ `Worker` listening on the `'emails'` queue, sending a static welcome email via nodemailer (Gmail SMTP, port 465). Listens for `'completed'`, `'failed'`, and `'error'` events and logs each. Graceful shutdown on `SIGTERM`/`SIGINT` (`docker compose down` sends `SIGTERM`) — `await worker.close()` before exiting, so a job that's mid-send finishes instead of being cut off. New `"worker"` script in `package.json` runs it locally the same way `seed.js` runs (`node --env-file=.env`).
- **First Dockerfile in this repo**, worker-only: `node:20-alpine`, installs dependencies with `--ignore-scripts --omit=dev` (skips both the `prisma generate` postinstall hook and every devDependency — the worker never touches the database, so it needs neither), copies only `worker.js`, runs `node worker.js`. Plus a `.dockerignore` (`node_modules`, `.env`, `.git`).
- **`docker-compose.yml`**: new `worker` service, built from that Dockerfile, `depends_on: redis`, `restart: unless-stopped`. Its `REDIS_URL` is overridden under `environment:` to `redis://redis:6379` — inside Docker's network, containers reach each other by service name, not `localhost`. The **API stays on the host** (`npm run dev`, unchanged) — this mirrors a real production split where an API can run serverless (no long-lived process) but a queue worker fundamentally can't (it has to sit there listening forever).
- **`.env` / `.env.example`**: added `GMAIL_USER` + `GMAIL_APP_PASSWORD` (a Gmail-specific 16-character password, distinct from your real password, that only works for app SMTP access — requires 2-Step Verification on the account first).

**Key decisions and why**
- **Worker-only container, not "dockerize everything."** The API and frontend already work fine with `nodemon`/`vite` on the host — containerizing them would be pure overhead for local dev. The worker is the one piece that's genuinely a different *kind* of process (always-running, no HTTP interface), so it's the one piece that gets a container. This also happens to be exactly how you'd deploy this in real production: API as a Vercel serverless function, worker on a small always-on box (Railway/Render/Fly) — there's no free host for a persistent worker process, so that's a real ~$5/mo cost if this ever needs to run live, separate from finishing it for the course.
- **DB-free worker.** The `User` model has nothing to personalize a welcome email with beyond the email address itself, so the worker never imports Prisma at all — one less thing that container needs (no `DATABASE_URL`, no generated client, no dependency on Postgres being reachable from inside the worker).
- **A second, separate ioredis connection for BullMQ, not a shared one.** Tempting to reuse `lib/redis.js`'s existing singleton — wrong on inspection: that client is deliberately configured to fail fast (`enableOfflineQueue: false`, for the health check's sake), but BullMQ needs the opposite (`maxRetriesPerRequest: null`, so its internal retry/blocking logic works correctly) and needs its jobs to survive a brief Redis hiccup by buffering rather than immediately erroring. Same library (ioredis), two different jobs, two different configurations — sharing one instance would have been subtly wrong for one of the two use cases.
- **Fire-and-forget with a `.catch`, no retry logic in the caller.** BullMQ's own `attempts: 3` + backoff already handles transient failures once a job is queued — the only failure worth handling in `auth.service.js` is *enqueueing itself* failing (e.g., Redis is down), and there the correct behavior is "log it and let the signup succeed anyway," not retry the enqueue.

**Problems hit and how they were solved**
- **Code review caught two real issues before they shipped**, both fixed:
  1. The `Worker` had `'completed'`/`'failed'` listeners but no `'error'` listener. BullMQ creates its own internal Redis connection for blocking operations (a `.duplicate()` of the one we pass in) that does **not** inherit our `connection.on('error', ...)` handler — so a Redis blip on that internal connection would have logged a bare, unprefixed error instead of something traceable. Fixed with one more listener: `worker.on('error', ...)`.
  2. The Dockerfile's `npm install` (no flags beyond `--ignore-scripts`) was installing the *entire* `dependencies` + `devDependencies` list — Express, Prisma, Vitest, everything — even though `worker.js` only needs 3 packages. Fixed by adding `--omit=dev`; the remaining unused *production* deps (express, pg, etc.) are accepted as-is, since fully trimming that would need a separate worker-specific `package.json`, which is more machinery than this repo's single-`package.json` design calls for.
  3. (Caught by the same review, no fix needed — verified as a non-issue): whether the Dockerfile's `COPY src/lib/emailQueue.js` line was needed. It wasn't — `worker.js` builds its own `Worker` directly against the queue name string `'emails'` and never imports `emailQueue.js` (that file is only used by the producer side, `auth.service.js`, which isn't part of the worker image). Removed the unnecessary `COPY` line.
- **Gmail App Password not ready yet.** You don't have 2-Step Verification / an App Password set up on your Gmail account, so `GMAIL_USER`/`GMAIL_APP_PASSWORD` are still empty placeholders in `.env`. Everything else was built and verified without them — see below. The one thing still unverified is an actual email landing in a real inbox; that's the next thing to check once the App Password is in place.

**How we verified (end-to-end, without a real Gmail send)**
- `docker compose build worker` → succeeds; `docker compose up -d` → worker container starts, logs `Email worker started, listening on queue "emails"`, no Redis connection errors (proves `REDIS_URL=redis://redis:6379` resolves correctly inside Docker's network).
- Registered a real new user via `curl` against the host API → `201`. Inspected Redis directly with `redis-cli` (`KEYS '*emails*'`, `HGETALL bull:emails:1`) and confirmed a `welcome` job was enqueued with the right `{ userId, email }` payload, and that the worker had picked it up (`processedOn` set) — it's sitting there attempting the SMTP handshake with empty credentials, which is the expected state until real credentials exist.
- **Resilience check:** stopped the `redis` container, registered another user → still `201`, `/health` correctly reported `redis: "down"`, and the API process did not crash. Restarted Redis, everything recovered.
- Full existing test suite (14 scheduling tests, untouched by this slice) still passes.

**New concepts introduced**
- **Producer-consumer pattern**: one part of the system creates units of work ("producer" — here, the register endpoint) and drops them somewhere; a different part ("consumer" — `worker.js`) picks them up and does the work, on its own schedule, in its own process. They're decoupled — the producer never waits for the consumer, and the consumer doesn't care who produced the job.
- **Job queue (BullMQ)**: a list of pending "jobs" (small pieces of data describing work to do) stored in Redis, with a library on top that handles the hard parts — retries with backoff, not losing jobs on a crash, one worker not double-processing a job another worker already grabbed.
- **Fire-and-forget**: calling an async function but not `await`ing it (just attaching a `.catch` so a failure doesn't go fully silent). Used here specifically so a slow or failing side-effect (queueing an email) can never block or break the main thing the request is doing (creating the account).
- **Worker process**: a program that runs forever, doing nothing but pulling jobs off a queue and processing them — no HTTP server, no incoming requests, just a loop. Fundamentally different from a serverless API function, which only exists for the duration of one request — which is exactly why it needs its own container instead of living inside the existing `nodemon`-run API.
- **Gmail App Password**: a 16-character password Google generates specifically for third-party apps/scripts to send mail via SMTP, separate from your real account password, and only available once 2-Step Verification is turned on. If it leaks, you revoke just that one App Password without changing your real password.

**You should be able to explain**
1. Why does `registerUser` call `emailQueue.add(...)` without `await`ing it, and what would go wrong (concretely) if it were awaited and Redis happened to be down at that moment?
2. `src/lib/emailQueue.js` and `src/lib/redis.js` both open a connection to the same Redis server, but deliberately don't share one connection object. What's the actual difference in configuration, and what would break if they *did* share one?
3. Why does only `worker.js` get a Dockerfile/container, while the Express API and the React frontend keep running directly on your machine with `nodemon`/`vite`?

## 2026-07-22 — Bug fix: "Due today" showed only an 80-character preview

Caught by you while looking at the Due today list: a long item's text got cut off with no way to see the rest, so you couldn't actually tell what you were being asked to review.

**Root cause:** `GET /items/due` was mapping items through `toItemSummary` — the same mapper used for the *paginated* `GET /items` list, which the spec explicitly says should show "a text preview." But that line in `submission-requirements.md` is about the paginated list specifically; it says nothing about the due queue, and functionally you can't review something you can't read. The due queue was reusing the wrong mapper.

**Fix (3 small edits, no new endpoint):**
- `src/controllers/items.controller.js`: `listDue` now maps with `toItemDetail` instead of `toItemSummary` — full `text` instead of an 80-character `preview`.
- `openapi.yaml`: `/items/due`'s response schema now points at `ItemDetail` instead of `ItemSummary`, so the docs match what the endpoint actually returns.
- `frontend/src/Dashboard.jsx`: the due-list row now renders `item.text` instead of `item.preview`.
- `frontend/src/App.css`: `.due-list li p` gained `white-space: pre-wrap` (so multi-line notes keep their line breaks instead of collapsing to one line) and the row's `align-items` changed from `center` to `flex-start` (so the Review/Skip buttons sit at the top of a tall paragraph instead of vertically centered against it, which looked odd once rows could be several lines tall).

**Verified:** created a backdated, deliberately long multi-line item via `curl` against the demo account, logged into the frontend as demo, confirmed the full text (all three lines, with line breaks intact) rendered in the Due today list with no truncation and no console errors — then deleted the test item and confirmed all 14 backend tests still pass.

**You should be able to explain**
1. Why doesn't this fix conflict with the spec's "lists show a text preview" line — which endpoint does that line actually apply to?
2. `toItemDetail` was already built for `GET /items/:id` — why did reusing it for `/items/due` require no changes to the mapper itself?

## 2026-07-22 — Fix: prod database was never seeded (demo/admin couldn't log in live)

Caught when trying to demo the deployed app: `demo@example.com` / `admin@example.com` returned "Invalid email or password" on the live Vercel URL, even though they work fine locally.

**Root cause:** back in Part 7, the deploy deliberately ran only `prisma migrate deploy` against the production Neon database (creates the table structure), never `npm run seed` (creates the fake demo/admin accounts + sample items) — seeding real fake data into a "real" production database wasn't something we wanted to do by default. That was the right call at the time, but it means the live site has always had an empty `users` table.

**Fix:** ran `npm run seed` once, pointed at the Neon production connection string instead of local Docker Postgres — `DATABASE_URL="<prod-url>" node --env-file=.env prisma/seed.js`. Since a shell-set env var takes precedence over `--env-file`'s values (verified this experimentally first, rather than assuming), everything else (`PORT`, `JWT_SECRET`, etc.) still loaded from local `.env` as normal — only `DATABASE_URL` pointed at prod for this one command. `seed.js` uses `prisma.user.upsert` with `update: {}`, so it's safe to run more than once: it only *creates* the two accounts if they don't already exist, never overwrites anything.
- **You ran the actual command yourself, in your own terminal, outside this chat** — specifically to avoid pasting a production database password into the conversation again (see the still-unresolved Neon password exposure from 2026-07-18). I only verified the *result* afterward with `curl` against the live login endpoint, which needs no password.

**Verified:** `curl`'d `/auth/login` on the live backend for both accounts → `200` + a real JWT, for both `demo@example.com`/`Demo1234` and `admin@example.com`/`Admin1234`.

**New concepts introduced**
- **Environment parity gap**: when your local dev environment and production don't actually contain the same data (or even the same *kind* of setup), a feature that "works" locally can still be broken live — the code was never the problem here, the data was.
- **`upsert` as a safe "run this again" guard**: `update: {}` means "if it already exists, touch nothing" — this is what makes a seed script safe to run against a database you're not sure is already seeded, without a separate "check first" step.

**You should be able to explain**
1. Why did the exact same login code work locally but fail on the live URL — what was actually different between the two databases?
2. In the command `DATABASE_URL="<prod-url>" node --env-file=.env prisma/seed.js`, which value wins for `DATABASE_URL` — the one in the shell, or the one in `.env` — and why does that matter here?

## 2026-07-22 — Email queue: real end-to-end verification (Gmail App Password)

Closes out the BullMQ email-queue task from earlier this session. `GMAIL_USER`/`GMAIL_APP_PASSWORD` are now genuinely saved in `.env` (took a couple of tries — the file wasn't actually being saved at first, caught by checking its last-modified timestamp rather than trusting "I added it").

**What was done:**
- `docker compose up -d --force-recreate worker` — a plain `restart` wasn't enough; Docker only reads `env_file` values when a container is *created*, not on every restart, so the worker needed to be fully recreated to pick up the newly-saved Gmail credentials.
- Registered a fresh throwaway account through the running frontend, using a real inbox, and confirmed the welcome email actually arrived.
- Along the way, incidentally proved the offline-queue design decision from earlier actually works: a leftover test job from the Redis-down resilience test (queued while Redis was stopped, then flushed automatically once Redis came back — ioredis's offline queue buffering, not dropping, the command) had failed twice against the old empty credentials, got picked back up as a "stalled" job when the worker container was recreated, and succeeded on its final retry attempt with the real credentials. Retries + backoff + stalled-job recovery, all doing exactly what they're supposed to, unprompted.
- Cleaned up the throwaway test accounts (`queuetest1@example.com`, `queuetest2@example.com`, `gmail-e2e-test@example.com`) from the local database afterward — confirmed no orphaned items/reviews were left behind.

**New concepts introduced**
- **Stalled job recovery**: if a BullMQ worker holding a job dies or disappears (crash, container restart) without marking the job finished, BullMQ eventually notices the lock went stale and hands the job to whichever worker is listening next, for another attempt — this is what let the leftover test job get a fresh try instead of being stuck forever.

**You should be able to explain**
1. Why did `docker compose restart worker` (used earlier, mid-session) not pick up the new Gmail credentials, but `--force-recreate` did?
2. The `queuetest2` job had already failed twice with the old empty credentials — why did it get a third attempt instead of just staying failed?

## 2026-07-22 — Bonus: "Due today" rows are now clickable too

You noticed that after the earlier fix (full text instead of preview), "Due today" still had no way to see an item's dates or review history the way "All items" already could. Fixed by reusing the exact same `ItemDetail` component for both lists — no new screen needed.

**What was built**
- `frontend/src/Dashboard.jsx`: the due-list `<li>` now has the same clickable/keyboard-accessible pattern "All items" already had (`role="button"`, `tabIndex`, click + Enter/Space handling), opening the same `<ItemDetail>`.
- One real wrinkle "All items" never had to deal with: due-list rows contain **Review/Skip buttons inside the clickable row**, so a click on those buttons must NOT also open the detail view. Fixed with `e.target.closest('button')` — if the click (or Enter/Space keypress) originated inside any button, the row's own click handler does nothing and lets the button's own handler run instead.
- `onChanged` (called when `ItemDetail` edits or deletes something) now refreshes whichever list you actually came from — `refreshDueItems` if you opened the detail from "Due today", `refreshAllItems` otherwise — instead of always refreshing "All items" regardless of where you were.

**Key decisions and why**
- **No new component.** `ItemDetail` already showed everything asked for (full text, dates, review history, edit, delete) — it just wasn't reachable from the due list. Reusing it is the same "rule of two" reasoning from the admin-panel slice: one component, two entry points, not a fork.
- **Review/Skip stayed out of the detail view.** You can still only Review/Skip from the list row, not from inside the detail screen — noted as the deliberate scope cut here; if that friction turns out to matter in practice, adding those two buttons to `ItemDetail` is a small follow-up, not a redesign.

**Problems hit and how they were solved**
- **Testing this polluted the seeded demo data** — clicking "Skip" during verification pushed the seeded "overdue" item's `nextReviewDate` forward by a day, which would've made the next demo look wrong. Fixed by simply re-running `npm run seed` (safe and idempotent for the demo user specifically — it wipes and recreates *only* that user's items every time), restoring the clean due/overdue/archived spread.

**You should be able to explain**
1. A click on the "Skip" button is physically *inside* the clickable `<li>` — so why doesn't clicking Skip also open the detail view?
2. Why does `onChanged` need to know whether you came from "Due today" or "All items," instead of just always refreshing one specific list?

## 2026-07-22 — Bug fix: "Due today" never refreshed after the first page load

Caught live: you had the app open while I was resetting demo data in the background (`npm run seed`, cleaning up my own test residue). Your "All items" tab correctly showed the fresh data (4 due items, one of them a stale-looking "2-day review" row) — but "Due today" still showed only 2, and clicking an "All items" row that pointed at data from *before* the reset 404'd.

**Root cause:** two very similar-looking `useEffect`s in `Dashboard.jsx`, with one meaningful difference. "All items"'s effect depends on `[view, statusFilter, page]` — so switching to that tab (which changes `view`) always triggers a fresh fetch. "Due today"'s effect had an empty dependency array `[]` — meaning it only ever ran once, the very first time the component mounted, and never again for the rest of the browser session, no matter how many times you switched away and back to that tab.

**Fix (one line, `frontend/src/Dashboard.jsx`):** changed the due-items effect from `useEffect(() => { refreshDueItems(); }, [])` to `useEffect(() => { if (view === 'due') refreshDueItems(); }, [view])` — the exact same pattern "All items" already used. Now switching to "Due today" refetches every time, same as every other tab.

**Verified:** reloaded fresh (4 due items, matching a direct API call) → switched to "All items" → reviewed one of the due items via `curl` (simulating "something changed while you were on a different tab") → switched back to "Due today" → the reviewed item correctly disappeared without a full page reload. Before the fix, it would have stayed visible until you refreshed the whole page.

**New concepts introduced**
- **Stale UI state**: React only re-renders with new data when something tells it to fetch again (an effect firing, a state update) — it never magically notices the *server's* data changed on its own. A tab that "looks fine" can silently be showing a snapshot from minutes (or a full backend reset) ago if nothing re-triggers its fetch.

**You should be able to explain**
1. Both effects fetch data for their respective tab — why did only one of them ever run more than once, and what specific piece of code caused that difference?
2. If you Review or Skip an item directly (the buttons already call `refreshDueItems()` themselves), why did this bug not show up in *that* flow — only when switching tabs?

## 2026-07-22 — Docs: fixed stale claims, added user manual + developer handover, set a docs policy

Closing out a long session with documentation work: two existing docs had drifted out of sync with what's actually built, and two new docs were added.

**What was built**
- **Fixed two stale docs**: root `README.md` never mentioned Redis, the Docker worker, or the `GMAIL_USER`/`GMAIL_APP_PASSWORD` setup — someone following it today couldn't get the email queue running. `frontend/README.md` still said editing/export/admin were "backend-only for now," even though the frontend has wired all 14 endpoints for several sessions now. `submission-requirements.md`'s trade-offs section still listed the frontend UI as "backlogged" — corrected, with a pointer to this journal.
- **New `user-manual.md`**: plain-language, no-technical-background guide for someone just *using* the deployed app — what 2-7-30 means in practice, adding items, the due-today workflow, review vs. skip, editing/deleting, exporting, admin features, and an FAQ.
- **New `developer-handover.md`**: an architecture snapshot for someone picking up the codebase cold — stack table with one-line "why," a repo-layout map, the data model, the scheduling logic's pure-function design (with the "one rule, two guarantees" due-check explained), the email queue's producer/consumer split and its Docker rationale, timezone/date handling, auth/security notes, and a section explicitly mapping out how every doc in this repo relates to the others.
- Both new docs linked from the top of `README.md` so they're actually discoverable.

**Key decisions and why**
- **A policy on how the "plan docs" get treated going forward**, decided by asking directly rather than guessing: `submission-requirements.md`/`build-plan.md` stay **frozen** as the original graded scope and build order — new bonus features don't get new sections added there. Only outright factual errors get fixed (like the stale frontend-UI backlog claim). `implementation-journey.md` remains the one living record of everything built, bonus included. Reasoning: blurring "what was originally assigned" into "everything we've since added" would make it impossible to later tell the two apart.
- **`README.md`/`frontend/README.md` are NOT covered by that freeze** — those are regular setup docs meant to reflect current reality, so keeping them accurate is just normal maintenance, not scope creep.
- **Grounded every factual claim in the new docs against the actual code** before writing, rather than working from memory of what was built — checked `package.json` scripts, `.env.example`, the live endpoint table, the Prisma schema, and `schedule.service.js`'s actual exports. This was a direct reaction to having *just* hit two staleness bugs in the existing docs — worth the extra minute of grepping to not immediately introduce a third.

**New concepts introduced**
- **Documentation drift**: docs don't automatically stay accurate as code changes — every fact in a written doc is a claim that was true *at the time it was written*, and nothing enforces that it stays true. The fix isn't "write more docs," it's periodically checking existing claims against current code, the same way you'd distrust a memory or assumption.

**You should be able to explain**
1. What's the actual difference in how `submission-requirements.md` and `README.md` are meant to be maintained going forward, and why does that split make sense?
2. Both README files had gone stale in different ways — what's one concrete way to *notice* a doc has gone stale, rather than just trusting it because it was written by someone (or something) careful?

## 2026-07-25 — Frontend redesign: design direction locked (no code changed this session)

A pure design/UX session — no app code touched. The goal was to pick a
visual direction and a gamification approach for a full frontend revamp,
before handing the actual build to a new session. Ended with a locked
design and a static reference file committed to the repo
(`design/review-history-demo.html`) — see `developer-handover.md` §10 for
the full spec this session produced.

**What was built**
- A throwaway comparison artifact (Claude Artifacts, not part of the repo)
  iterating through three full visual directions — "Lab Notebook" (paper/
  ink/amber, signature = a per-item memory-retention sparkline), "Almanac"
  (indigo night sky/gold, signature = a moon-phase review-history tracker),
  "Trail" (forest green/blaze orange, signature = items-as-waypoints on a
  path) — before converging on Almanac.
- The final, approved design saved as a real, self-contained HTML file in
  the repo at `design/review-history-demo.html` — open it in any browser
  directly, no dev server needed. It's the actual reference for implementation,
  not just a description of one.

**Key decisions and why**
- **Almanac over Trail**, even though both palettes were liked. Almanac
  spends its "boldness" in exactly one place — gold is the only color doing
  branding work, indigo just recedes as a considered near-black background.
  Trail's forest green was itself a present, saturated color, competing with
  its own orange accent for attention. A muted, more-neutral version of
  Trail's background was tried and explicitly rejected (screenshot review) —
  the desaturation killed the richness that made the palette appealing in
  the first place, so "avoid a green/orange color collision with a future
  'success' state" got solved by picking a palette without green as the
  brand hue at all, rather than by muting a green brand hue.
- **Lab Notebook dropped entirely.** Its signature idea (a visual memory
  "retention curve" per item) assumed data the schema doesn't have —
  `Review` only stores `date` + `result` (`REVIEWED`/`SKIPPED`), no
  difficulty/confidence rating, and the schedule is fixed 2-7-30, not an
  adaptive algorithm. A retention curve would have been a decorative shape,
  not something computed. Caught by checking `prisma/schema.prisma` directly
  instead of assuming the idea was buildable.
- **Gamification stays visual-only, computed client-side, no new persisted
  state** — reconfirmed multiple times across the session. The one addition
  that isn't purely client-side is a small *read* endpoint for review
  history (see below) — deliberately distinguished from "new state," since
  it adds a query, not a table or field.
- **History grid: binary/three-state, not graded intensity.** The first
  build of the Almanac direction used 5 moon phases to represent *how many*
  reviews happened each day (a GitHub-heatmap-style volume scale). User
  feedback ("some full moons in the less part," "just a bunch of tiny dots")
  correctly identified this as broken — confirmed by an advisor review: the
  only channel encoding "less → more" was shape geometry (the box-shadow
  moon-phase trick), and shape alone is a weak visual variable for
  at-a-glance scanning. Fixed by splitting the job in two: the bulk grid
  became a simple 3-state read (full/half/new — see below), and the one
  place a *graded* fill still makes sense is today's single indicator, which
  shows a real, currently-queryable fraction (today's due count), not a
  guess about a past day.
- **Three real states for the grid, not two, and not five.** Binary
  (reviewed-or-not) was the first fix, then refined further: since
  `Review.result` is `REVIEWED` or `SKIPPED`, a day can honestly be
  classified as all-reviewed (full moon), mixed — reviewed *and* skipped
  (half moon), or no activity (new moon outline) — all real, no invented
  denominator. Skipping is a spec-intended, legitimate action (see
  `submission-requirements.md`'s skip behavior), so "half" is deliberately
  framed as neutral, not a lesser/failure state.
- **A new read-only backend endpoint is planned, with an index.** No
  existing endpoint returns "all of this user's reviews, grouped by day" —
  `GET /items` doesn't include reviews, `GET /items/:id` only covers one
  item, and `GET /export` does include everything but is semantically a
  data-export endpoint, not a page-load data source. Plan: a small endpoint
  (e.g. `GET /items/review-history`) doing a `groupBy` on `date`, scoped to
  a year/date-range (default: current year) so payload size and rendered
  grid cells stay bounded regardless of how many years of history
  accumulate. `Review` has no index today, and the endpoint needs to join
  `Review → Item` to filter by `userId` — `@@index([itemId, date])` is
  planned alongside it.
- **Stack for the rebuild: Tailwind CSS + `react-router-dom`**, both decided
  upfront (per this project's rule to present options before library/
  architecture decisions) rather than mid-build. The current frontend has no
  router at all — `App.jsx` swaps `Dashboard`/`AuthForm` via local state —
  and the redesign explicitly includes restructuring navigation (a dedicated
  history page), so real routes are needed either way.

**Problems hit and how they were solved**
- Caught the retention-curve idea couldn't be built honestly (see above) by
  reading the actual Prisma schema before committing to the design, not
  after.
- Caught the moon-phase grid's legibility bug via direct user feedback plus
  an advisor consult, rather than continuing to iterate on the same broken
  encoding.
- Caught a light-mode-specific contrast bug (the moon-phase version's "no
  review" outline color was nearly the same value as the light-mode
  background, so empty days were almost invisible) — fixed, then reverted at
  the user's request along with a font-weight tweak, since the final
  approved look was the version from before those two fixes. Worth
  remembering for whoever builds this for real: the empty/new-moon state's
  contrast in light mode should get another look before shipping.

**New concepts introduced**
- **The denominator problem**: a percentage or intensity visualization is
  only honest if the total it's a fraction *of* is actually known and
  stored. "3 reviews happened Tuesday" is real; "you reviewed 60% of what
  was due Tuesday" is fabricated the moment there's no stored record of how
  many items were due that day. This sank both the retention-curve idea and
  the graded history grid, and is the reason today's indicator (a real,
  currently-queryable denominator) works while a past day's would not.
  Same lesson, both places it appears in this session — grep for
  "denominator" or "fabricat" in this entry to see both.
- **Spend your boldness in one place**: a design-craft principle — pick one
  element to be visually loud (Almanac's gold, or a single flourish like
  today's growing moon) and keep everything around it quiet, rather than
  having two or more elements compete for attention (Trail's green base vs.
  its orange accent, or a moon-phase icon repeated hundreds of times across
  a whole year instead of once).

**You should be able to explain**
1. Why does a review-history heatmap need a stored "how many items were due
   that day" to show *volume*, but not to show *whether anything happened*
   that day?
2. What's the difference between the new `GET /items/review-history`
   endpoint being planned and just reusing `GET /export` from the frontend —
   why wasn't reusing it the right call?
3. Why was "half moon = skipped something" deliberately designed to *not*
   look like a worse/sadder state than a full moon?

## 2026-07-25 — Frontend redesign: backend piece built (review-history endpoint)

Build session for the locked Almanac design. First feature: the backend
support the history page needs. No frontend code yet.

**What was built**
- `prisma/schema.prisma`: added `@@index([itemId, date])` to `Review`,
  migrated locally (`20260725110336_add_review_index`).
- New route `GET /items/review-history?year=2026` (route + controller +
  service). Groups this user's `Review` rows by date for the given year,
  returns only days with activity: `{ year, days: [{ date, reviewCount,
  skipCount, state }] }`. `state` is `'full'` (reviewed, no skips that day),
  `'half'` (any skip that day — alone or mixed with a review), or the day is
  just absent from the array (no activity at all).
- The grouping/state logic lives in its own pure function
  (`deriveReviewHistory` in `items.service.js`), separate from the
  database-calling part (`getReviewHistory`), so it could get a real unit
  test (`tests/reviewHistory.test.js`) without needing a database — same
  trick `schedule.service.js` already used for the scheduling math.
- Verified live against the real dev database, not just the unit test:
  logged in as the seeded demo user, hit the endpoint (got real seeded
  `full` days back), then skipped an item dated today and confirmed it
  showed up as today's `half` day.

**Key decisions and why**
- **Skip-only day = half moon**, not a 4th state and not "no activity."
  Decided with the user: reviewed-only = full, any skip involved = half,
  nothing at all = blank. The locked spec's original wording ("mixed —
  reviewed *and* skipped") technically didn't cover a day with *only*
  skips — the demo's random data generator never produced that case, so it
  went unnoticed until building the real thing. Caught by reasoning through
  the state function before writing it, not after.
- **Scope for this build**: history page gets built and wired to a real
  backend first; restyling the existing Dashboard/AuthForm/ItemDetail/
  AdminPanel screens is explicitly deferred to a later session, since the
  approved reference file (`design/review-history-demo.html`) only covers
  the history page — those other four screens have no approved look yet.
- **Sparse response, not one entry per calendar day.** A day with zero
  `Review` rows can't come back from a `GROUP BY` at all (see below), and
  even if it could, we wouldn't want it to — payload size should grow with
  actual activity, not with how many days are in the calendar.

**Problems hit and how they were solved**
- Local Postgres wasn't running (Docker daemon was off) when trying to run
  the migration. Started Docker Desktop, then `docker compose up -d db
  redis`, then the migration went through.

**New concepts introduced**
- **Why the index needs `itemId`, not `userId`**: `Review` has no `userId`
  column — only `Item` does. Finding "this user's reviews" means first
  finding their `Item` rows, then finding `Review` rows attached to those
  items — a join, not a direct filter. `@@index([itemId, date])` is what
  lets Postgres jump straight to a given item's reviews (then narrow by
  date) instead of scanning the whole `reviews` table. Analogy: a library
  where checkout cards are filed by book ID, not borrower name — to find
  what one person borrowed, you first find their books, then look up those
  books' cards; sorting the cards by (book ID, date) is what makes that
  lookup fast instead of a full shelf-by-shelf search.
- **Why `GROUP BY` can never produce an empty group**: `GROUP BY` only
  groups rows that actually exist in the table. If nobody touched anything
  on a given day, there is no `Review` row with that date — so there's
  nothing for `GROUP BY date` to gather into a group. It's not a filtering
  step applied afterward; a day with zero rows structurally cannot appear
  in a `GROUP BY` result, no matter what label (`'none'`, `null`, anything)
  you might want to give it. Tiny example: if `reviews` only has rows for
  Jan 3 and Jan 5, `SELECT date, count(*) FROM reviews GROUP BY date`
  returns exactly two rows — Jan 4 was never a candidate, because there was
  no Jan-4 row to begin with.
- Note: a string like `'none'` is *not* a JS-truthiness problem (only `''`,
  the empty string, is falsy) — that reasoning doesn't apply to why absent
  days aren't in the response; the `GROUP BY` mechanics above are the actual
  reason.

**You should be able to explain**
1. Why does the index need to include `itemId`, when the query filters by
   `userId`?
2. Why can a day with zero `Review` rows never show up in a `GROUP BY`
   result, regardless of how we might want to label it?
3. Why is skip-only treated the same as mixed (reviewed + skipped) for the
   history grid's state, instead of being its own 4th state?

## 2026-07-25 — Frontend redesign: Tailwind + routing wired up

Second build step. Still no visual feature yet -- this is the plumbing the
history page needs: a styling system that can express the Almanac look, and
a URL the page can live at. Verified both live in a browser before moving on.

**What was built**
- Installed **Tailwind CSS v4** (`@tailwindcss/vite` plugin -- no separate
  PostCSS config file needed in v4) and **`react-router-dom`**.
- `frontend/src/index.css`: imported only Tailwind's `theme` and `utilities`
  layers, deliberately **skipping `preflight`** (Tailwind's browser-reset
  layer). Added the Almanac palette as `@theme` CSS variables
  (`--color-almanac-bg`, `--color-almanac-ink`, etc.), dark by default, with
  a `:root[data-mode="light"]` override and an OS-preference media query
  fallback -- same mechanism as the approved reference file.
- `frontend/src/main.jsx`: wrapped the app in `<BrowserRouter>`.
- `frontend/src/App.jsx`: added two routes -- `/` (existing Dashboard/
  AuthForm swap, logic untouched) and `/history` (new page, placeholder for
  now). Dashboard's own internal due/all/admin tab-switching was left
  exactly as it was -- not converted to nested routes, since restyling/
  restructuring that screen is explicitly deferred to a later session.
- Added a "Review history" link in the Dashboard header.
- Verified in a real browser (Playwright): `/history` renders the Almanac
  palette correctly (serif heading, muted link, indigo-tinted background);
  `/` still renders pixel-identical to before -- confirming the preflight
  skip actually worked, not just in theory.

**Key decisions and why**
- **Skip Tailwind's preflight layer.** Preflight is a global reset (strips
  default button/heading/list styling) that applies the moment the
  stylesheet loads, regardless of which elements have Tailwind classes on
  them. The existing Dashboard/AuthForm/ItemDetail/AdminPanel screens still
  lean on un-reset browser defaults working together with `App.css`.
  Importing all of Tailwind (`@import "tailwindcss"`) would have silently
  restyled those screens without a single line of their code changing.
  Importing `theme` + `utilities` only avoids that entirely.
- **Tokens as CSS variables, not a new component-level dark-mode context.**
  Every Almanac utility class Tailwind generates resolves to
  `var(--color-almanac-*)`, not a literal hex value. That's *why* the
  light/dark toggle (built in the next step) will only ever need to flip one
  `data-mode` attribute on `<html>` -- the browser re-evaluates which CSS
  rule wins for that variable and repaints every element using it, with no
  React re-render or JS needed to "push" the new colors around.
- **Minimal router integration, not a full route rewrite.** Only added what
  the new page needs (`/` and `/history`). Dashboard's internal view state
  is left alone on purpose -- turning it into real nested routes is a
  reasonable future improvement, but out of scope for "add the history page"
  and would touch a screen with no approved redesign yet.

**Problems hit and how they were solved**
- None -- infra install and wiring went cleanly; the Docker/DB issue from
  the previous step didn't recur since the backend server was already
  running against the now-started containers.

**New concepts introduced**
- **CSS layers / Tailwind's three-layer import.** Tailwind v4 ships as
  `theme` (design tokens), `base`/`preflight` (a browser CSS reset), and
  `utilities` (the actual `bg-*`/`text-*`/etc. classes) as separately
  importable pieces, instead of one all-or-nothing stylesheet. Importing a
  subset is a normal, supported way to let Tailwind coexist with an existing
  hand-written stylesheet in the same app.
- **CSS custom properties resolve at paint time, not build time.** A
  Tailwind utility like `bg-almanac-bg` compiles down to
  `background-color: var(--color-almanac-bg)` -- the browser looks up that
  variable's current value fresh on every repaint, following the normal CSS
  cascade. That's what makes a one-attribute dark/light toggle "just work"
  everywhere at once.

**You should be able to explain (answered here per your standing note to
auto-log and keep moving, rather than pausing for a reply each time):**

1. *Why would importing all of Tailwind (including preflight) have risked
   breaking the existing Dashboard, even though no new Tailwind classes were
   added to `Dashboard.jsx` itself?* -- Preflight resets styles by targeting
   plain HTML element selectors (`button`, `h1`, `ul`, etc.), not "elements
   with a Tailwind class." It doesn't check whether an element opted in --
   it applies globally the moment the stylesheet is loaded. Since
   `Dashboard.jsx`'s markup depends on the browser's *un-reset* defaults
   combining with `App.css`'s rules, Preflight would strip those defaults
   out from under it and change how Dashboard looks, without Dashboard's own
   code being touched at all.
2. *Why does the light/dark toggle only need to change one attribute
   instead of touching every styled element in JS?* -- Because color values
   are stored as CSS variables (`--color-almanac-ink`, etc.), and every
   utility class references the variable, not a literal color. Setting
   `data-mode="light"` on `<html>` changes which CSS rule defines that
   variable; the browser's normal cascade + repaint propagates the new value
   to every element using `var(--color-almanac-ink)` immediately. No
   component re-renders, no JS walks the DOM -- it's the same mechanism as
   changing one recipe ingredient and every dish that references "the
   sauce" tasting different, without re-cooking each dish individually.

## 2026-07-25 — Frontend redesign: review history page built (feature complete)

Third build step: the actual page. Built against the real backend endpoint
from step one, not mock data, and checked in a real browser (Playwright) at
every stage rather than trusting the code to be right by inspection.

**What was built**
- `frontend/src/api.js`: added `getReviewHistory(token, year)`.
- `frontend/src/ReviewHistoryPage.jsx`: the real page, replacing the
  placeholder from the infra step. Fetches `getReviewHistory` (for the grid)
  and `getDueItems` (for today's remaining workload) in parallel, derives
  today's fraction, and renders:
  - **Today's moon** -- a single 64px circle, 5 discrete phases (not a smooth
    fill), same `inset Npx` box-shadow trick and same ratio thresholds
    (0.3 / 0.55 / 0.85) as the approved reference file, ported as inline
    styles rather than refactored into Tailwind classes since the values are
    tied to this one element's pixel size.
  - **The month grid** -- one row per month, from January through the
    current month (or all 12 for a past year), one small circle per day,
    three states (full / half / no border-fix applied to the last one --
    see below).
  - A **year switcher** (`<` `2026` `>`), disabled going past the current
    year -- the backend's `year` param existed but had no way to reach past
    years from the UI until this.
  - The **light/dark toggle** button, setting `data-mode` on `<html>`.
- Live-verified in the browser: seeded data rendered as real full/half
  moons in the correct months; toggling light/dark actually re-themed the
  whole page; `npm run lint`, `npm run build` (frontend), and `npm test`
  (backend, 19 tests) all still pass.

**Key decisions and why**
- **"Handled today", not "reviewed today."** The due-items endpoint
  (`GET /items/due`) returns *outstanding* items -- anything with
  `nextReviewDate <= today`, which includes overdue backlog from previous
  days, not just what newly became due this morning. So "today's total" in
  the UI is honestly labeled as *today's workload* (due + overdue combined),
  and the numerator counts both reviews and skips (either one removes an
  item from that workload), not reviews alone -- otherwise skipping
  everything due today would make the indicator look emptier than it
  actually is, which is the same "don't make skipping look like failure"
  principle from the state-derivation decision two steps ago.
- **The `dueCount + handledToday` trick for today's total.** There's no
  stored "how many were due at the start of today" -- once an item is
  reviewed or skipped, it leaves the due list. But nothing due today can
  have been resolved *before* today (no-early-reviews is a hard rule the
  scheduler already enforces), so *remaining due now* plus *today's review/
  skip count so far* reconstructs the original total exactly, with two
  numbers that are both real and queryable right now.

**Problems hit and how they were solved**
- **A real bug, caught by looking at a screenshot, not by reading the code.**
  The year-switcher and mode-toggle buttons rendered with the old app's
  orange button styling, even though `ReviewHistoryPage.jsx` never imports
  `App.css` or uses any of its class names. Cause: `App.css` had *unscoped*
  element selectors (`button { ... }`, `h1 { ... }`, `form { ... }`, etc.)
  with no `.app` qualifier, so they applied to every `<button>`/`<h1>`/etc.
  on the page, including the new one, the moment `App.css` loaded anywhere
  in the app (which it does, globally, via `App.jsx`'s import). Fixed by
  scoping those selectors.
  - **First fix attempt was itself a bug.** Scoping them as `.app button`
    (adding `.app` as a plain class-selector prefix) fixed the leak but
    *broke the old screens*: `.app form`'s specificity (class + element =
    two "weight units") became higher than the existing
    `.add-item-form { flex-direction: row }` override (one class = one
    weight unit) that used to win, so the add-item form's input and button
    stacked vertically instead of sitting side by side. Caught the same way
    as the original bug -- a screenshot comparison against the pre-change
    version, not by reasoning about the CSS in the abstract.
  - **Real fix**: `:where(.app) button` instead of `.app button`. `:where()`
    matches the same elements but always contributes *zero* specificity, so
    the scoping is invisible to every other selector's ranking -- the old
    screens' internal overrides (`.add-item-form`, `.tabs button`, etc.)
    keep exactly the priority they had before, while the new page still
    can't be reached by any of these rules at all.

**New concepts introduced**
- **CSS specificity is additive per selector "part", and scoping can
  accidentally change relative ranking.** A rule's specificity is a count
  of (roughly) IDs, classes/attributes, and element types in its selector --
  not just "is this rule more targeted." Prefixing an existing bare-element
  rule with a class doesn't just "make it more specific in general," it
  changes its rank *relative to every other rule*, which can silently flip
  which of two rules wins somewhere else in the file.
- **`:where()`**: a CSS selector wrapper that matches normally but always
  has zero specificity, no matter how complex the selector inside it is.
  Used here specifically to scope a rule to a container (`.app`) without
  that container adding any weight to the rule's specificity -- "match only
  inside here" without "and also outrank things that used to beat me."
- **Reconstructing a value from two live numbers instead of storing it.**
  "Today's total due" isn't stored anywhere, but it doesn't need to be --
  it's recoverable from *what's currently left* (queryable) plus *what's
  already been resolved today* (also queryable), given one true fact about
  the domain (no early reviews) that guarantees today's resolved items
  really were due today and not sitting in the log from three days ago.

**You should be able to explain**
1. Why did wrapping the scoping class in `:where()` fix the "Add item"
   button layout regression, when `.app button` (without `:where()`) did
   not, even though both versions stopped the leak into the new page?
2. Why does `dueCount + handledToday` correctly reconstruct today's original
   workload, when there's no `Review` or `Item` field anywhere that stores
   "how many were due when the day started"?
3. Why does the today-indicator's copy say "workload" instead of "due
   today", given what `GET /items/due` actually returns?

**Answers (auto-logged per your standing note, not gating on a reply):**
1. Both stop the leak (both only match inside `.app`), but they differ in
   how much specificity they add. `.app button` is a class selector *plus*
   an element selector -- two specificity "units" -- which is more than the
   one unit `.add-item-form` (a single class selector) had, so `.app
   button`-family rules started outranking overrides that used to win.
   `:where(.app) button` matches the identical set of elements, but
   `:where(...)` is specifically defined to always count as zero
   specificity -- so the rule's rank is exactly what plain `button` would
   have been, and every existing override keeps its old priority untouched.
2. Once an item is reviewed or skipped, `nextReviewDate` moves past today,
   so it drops out of `GET /items/due`'s result -- the due list only ever
   shows what's *still* outstanding, not what was outstanding originally.
   But the scheduler rejects early reviews/skips (an item can't be resolved
   before it's due), so anything with today's date in a `Review` row was
   genuinely due today, not leftover from earlier. That means "still due" +
   "resolved today" can't double-count or miss anything -- together they
   are exactly the original set, reconstructed from two numbers that are
   each real right now, without ever having stored the total anywhere.
3. Because `GET /items/due` filters on `nextReviewDate <= today`, not
   `nextReviewDate == today` -- it deliberately includes overdue backlog
   from previous days so nothing falls through the cracks. Calling that
   number "due today" would imply it's only what newly became due this
   morning, which overstates how much is actually new; "workload" doesn't
   make that claim and stays accurate either way.

## 2026-07-25 — Frontend redesign: two more native-element bugs, then handover prep

Caught from a screenshot the user sent of the dark-mode header, not from
reading the code -- second time a visual check found something code review
wouldn't have (see the CSS-specificity bug two steps ago for the first).

**What was found and fixed**
- The "← Back" link on the history page rendered in native browser
  link-purple (visited-link color), not the Almanac mute/gold colors,
  because it only had a `hover:` class and no explicit *default* text
  color -- anchors don't inherit color from a parent by default (the
  browser's own stylesheet sets it directly on the element, which beats
  inheritance). Fixed by adding `text-almanac-mute` alongside the existing
  `hover:text-almanac-accent`.
- Same root cause, second spot: Dashboard's new "Review history" nav link
  (a `<Link>`, i.e. an `<a>`) used `className="link"`, expecting
  `App.css`'s existing link styling -- but that rule was written as
  `button.link` (requires the element to *be* a button), so a plain `<a
  className="link">` matched nothing and fell back to native purple too.
  Generalized the CSS selector from `button.link` to `.link` so it covers
  both.
- While verifying the fix, spotted a related issue in the same screenshot:
  the year-switcher arrow buttons showed native gray button chrome (a
  visible box/border), because they only had a `hover:` text-color class
  and nothing resetting the browser's default button appearance. Added
  `bg-transparent border-0 p-0` to both.

**Key decision and why**
- **All three bugs share one root cause, now written down as a standing
  gotcha** (see `developer-handover.md` §10a): skipping Tailwind's
  Preflight (kept the old screens safe, per the earlier decision) means
  the new page gets *zero* CSS reset. Every native element keeps its raw
  browser default unless a class explicitly overrides it -- a `hover:`-only
  class on an `<a>` or `<button>` is a reliable smell for "this element's
  base/unstyled state was never set." Logged as an explicit pattern to
  watch for, not just three isolated fixes, since a next session adding
  more native elements (inputs, selects) will hit the same thing.

**Handover decision**
- Updated `developer-handover.md` §10 to split into **§10a (built: infra +
  history page, with the gotchas above)** and **§10b (not yet built:
  restyling Dashboard/AuthForm/ItemDetail/AdminPanel + revisiting their
  user flow/UX)** -- confirmed with the user that §10b is the next phase,
  and that it needs its own design-lock pass first, the same process this
  session used for the history page, not a straight port of one screen's
  tokens onto four different screens' layouts.

**You should be able to explain**
1. Why did the "← Back" link need an explicit `text-almanac-mute` class
   when it's nested inside a `<span>` that already has
   `text-almanac-mute` on it -- shouldn't color just inherit down?
2. Why did generalizing `button.link` to `.link` fix the Dashboard nav
   link without needing a separate rule just for `<a>` tags?

**Answers (auto-logged, not gating on a reply):**
1. CSS inheritance only fills in a property when nothing more specific sets
   it. Browsers ship their own default stylesheet rule that sets a color
   directly on `<a>` elements (blue for unvisited, purple for visited) --
   that's not "no color set," it's an explicit rule on the element itself,
   which always beats an inherited value from a parent, however specific
   the parent's own selector was. The `<span>`'s `text-almanac-mute` reaches
   plain text nodes fine; it never reaches the link's own color, because
   the link has its own rule already.
2. `.link` matches on class alone, regardless of which element carries that
   class -- `button.link` matches only when the element is *literally* a
   `<button>` with that class. `<Link>` from react-router renders an `<a>`,
   never a `<button>`, so `button.link` could never match it no matter what
   className was passed. Dropping the `button` part from the selector was
   the whole fix; nothing else needed to change.

## 2026-07-25 — Frontend redesign: the `:visited` link color, and a real verification limit

The user reported the "← Back" link still showing native visited-link
purple *after* the previous fix (which added a base `text-almanac-mute`
color) -- with a fresh screenshot from their own everyday browser, not
this session's automated one. Also asked to drop the underline, and to
lock in "follow the device's light/dark preference by default" as an
explicit rule for the redesign, not just an accidental side effect of how
the state happened to be written.

**What was found and fixed**
- `<a>` elements carry the browser's own `:link`/`:visited` color rules.
  A plain `.text-almanac-mute` class (no pseudo-class) *should* still win
  over those under normal cascade rules (author styles beat user-agent
  defaults regardless of specificity) -- but rather than trust that
  reasoning against a real, reported mismatch, the more robust fix is to
  target `:visited` explicitly: added `visited:text-almanac-mute` alongside
  the existing `text-almanac-mute` and `hover:text-almanac-accent`, plus
  `no-underline` (the second, separate ask).
- Locked "default to the device's OS light/dark preference; the in-page
  toggle is a manual override" into `developer-handover.md` §10a as an
  explicit rule for the *whole* redesign, not just this page. It already
  worked this way by construction (`mode` state starts `null`, so CSS falls
  through to `@media (prefers-color-scheme)` until the toggle sets an
  explicit value) -- writing it down turns "how it happens to behave" into
  "a decision a future screen must also follow."

**A real tool limitation, surfaced rather than glossed over**
- Tried to verify the fix by reading `getComputedStyle(link).color` and
  `document.querySelectorAll('a:visited').length` from this session's
  automated browser. Both came back looking "clean" (`length: 0`,
  computed color matching the intended unvisited value) -- but that's not
  proof of anything: browsers *deliberately* make `:visited` invisible to
  JavaScript (`getComputedStyle` is specified to always report as if
  unvisited, and `:visited` never matches via script), specifically so a
  page can't sniff a user's browsing history through CSS. On top of that,
  this session's automated browser almost certainly has no real,
  accumulated navigation history the way the user's actual daily browser
  does, so the bug may never even be reproducible here. Conclusion, stated
  plainly rather than re-claimed as fixed: **this class of bug cannot be
  verified by this session's tooling at all** -- the explicit
  `visited:text-almanac-mute` fix is the theoretically correct move
  regardless, but confirming it worked requires the user to check in their
  own browser, not another "confirmed in Playwright" claim.

**New concepts introduced**
- **`:visited` is a privacy-walled pseudo-class.** Unlike every other
  pseudo-class (`:hover`, `:focus`, `:disabled`...), browsers restrict what
  CSS properties `:visited` may change (color-related properties only, no
  layout-affecting ones) *and* hide its actual matching/computed state from
  JavaScript entirely. This is a deliberate, standardized privacy
  protection against "history sniffing" attacks (a page checking, per link,
  whether you've visited a given URL) -- not a bug or an oversight in any
  browser.
- **Not every visual bug is verifiable by this session's own automated
  browser check.** A screenshot from Playwright proves what Playwright's
  browser renders, in Playwright's browser state (no real history, a fresh
  profile) -- it does not prove what the user's own browser, with its own
  real history and settings, will show. Worth remembering as a general
  limit, not just for this one bug.

**You should be able to explain**
1. Why couldn't `document.querySelectorAll('a:visited').length` be trusted
   as proof that the link wasn't visited, even though it returned `0`?
2. Why does "default to OS preference, toggle overrides it" need to be
   written down as a rule, if the code already happened to behave that way?

**Answers (auto-logged, not gating on a reply):**
1. Browsers deliberately make `:visited` unobservable from script, as a
   privacy protection -- `:visited` is defined to never match through
   `querySelectorAll`/`matches()`/etc., regardless of the link's real
   visited state, precisely so a page can't use CSS + JS together to detect
   which of a list of URLs the user has actually visited. A `0` result is
   consistent with "not visited" and *also* consistent with "visited, but
   JS isn't allowed to see it" -- it can't distinguish the two.
2. Because "it happens to work" and "it's guaranteed to keep working" are
   different things. Without writing it down, a future session restyling
   Dashboard/AuthForm/etc. has no way to know this was an intentional
   product decision rather than an accident of how the `mode` state
   variable was initialized -- it could easily default a new screen to a
   fixed theme instead, technically matching "the redesign," while quietly
   breaking a rule nobody documented.

## 2026-07-30 — Instructor's final-project checklist: gap analysis + general rate limiting

**What happened**
The course instructor shared a PDF checklist of what the final project is
graded on: 5 sections (API design, security, database, performance/
resilience, DevOps), 14 items total. Went through the actual code
(grepping, not guessing from memory) to check each item off against what's
really built.

**Already satisfied, no new work:** clean layered structure + `/api/v1`
versioning, request validation/DTOs, Swagger docs at `/api/v1/docs`, CORS
allowlist, JWT + bcrypt auth, USER/ADMIN roles with an admin panel, Prisma
as the ORM, migrations + a seed script, database indexes, and the Redis-
backed email queue (built a week ago).

**Real gaps found, in priority order:**
1. General API rate limiting -- only `/auth/login` and `/auth/register`
   were protected; nothing stopped someone hammering every other endpoint.
2. DB connection pooling -- no explicit pool settings, just Prisma's
   defaults.
3. Resilient caching -- Redis exists (for the email queue) but nothing
   falls back to a cache when a database read fails.
4. Feature flags -- none exist anywhere in the app.
5. Full containerization -- the Dockerfile only builds the background
   worker; the web API itself isn't in `docker-compose.yml` at all (it
   deploys to Vercel instead). The checklist wants API + database + Redis
   + worker all wired together in one compose file.

One item -- "API backward compatibility" (supporting deprecated endpoints,
version fallback) -- was set aside as not worth building yet: there's only
ever been a v1 of this API, so there's no prior contract to stay
compatible with. Nothing to build until a v2 exists.

Picked gap #1 (rate limiting) to build first -- smallest, fastest, and it
closes an actual security hole (an unauthenticated attacker could currently
hit `/items` or any other route as fast as their network allows).

**What was built**
A new `src/middleware/generalRateLimit.js`, sitting alongside the existing
`authRateLimit.js` (which only covers login/register). It allows 100
requests per minute, and returns the same `429` JSON error shape the rest
of the API already uses (`{ error: { message, code: 'RATE_LIMITED' } }`)
rather than express-rate-limit's default plain-text response, so a client
handling API errors doesn't need a special case for this one.

Wired into `src/app.js` as one line, applied globally right after the body
parser -- before the route mounts, before Swagger docs, before the health
check. Every request shares the same 100/min budget. The stricter
login/register limiter still applies underneath it unchanged -- a login
attempt now has to clear both budgets, which is fine, since the auth
limiter's ceiling (10 per 15 min) is far tighter anyway.

**Why one middleware file, not folding it into `authRateLimit.js`**
Two small, separate files, each named for what it guards, matches how the
codebase already does it (`authRateLimit.js` for one route pair). Building
a shared "rate limiter factory" for just two call sites would be an
abstraction with no second real use case yet -- more code to explain for
no present benefit.

**Why 100 req/min per IP, not per logged-in user**
The checklist's own example is "100 req/min per IP/user" -- either
satisfies it. Limiting by IP is what express-rate-limit does out of the
box (no extra code), and it protects unauthenticated routes too (`/auth/
register`, the health check, Swagger docs) which a per-user key couldn't,
since there's no logged-in user yet on those requests.

**How it was verified**
Started the real server and fired 105 requests at `/api/v1/health` in a
loop with `curl`. Result: the first 100 came back `200`, the next 5 came
back `429` -- the limit trips exactly where configured. Also re-ran the
full test suite (19 tests) to confirm nothing broke -- they're pure unit
tests against service functions with no HTTP layer, so they were never
going to be affected, but worth checking anyway rather than assuming.

**New concepts introduced**
- **Rate limiting.** A middleware that counts requests from the same
  source (by default, IP address) within a rolling time window, and starts
  rejecting them with `429 Too Many Requests` once a limit is hit. Its job
  is to blunt abuse -- a script hammering the API, or a brute-force attempt
  guessing passwords -- without needing to know *why* the requests are
  happening.
- **Layered rate limits.** Nothing stops two rate limiters from applying to
  the same request. Here, every request pays into a loose global budget
  (100/min), and login/register additionally pay into a much stricter one
  (10/15min). The stricter one will always trip first for its own routes;
  the general one is the backstop for everything else.
- **`windowMs` / `limit`.** The two knobs express-rate-limit runs on: how
  wide the rolling time window is (`windowMs`, in milliseconds) and how
  many requests are allowed inside it (`limit`) before the `handler`
  (here, a `429` + the app's standard error JSON) takes over.

**You should be able to explain**
1. Why does the login/register limiter (10 per 15 min) still make sense to
   keep, now that there's also a general 100-per-minute limit on
   everything?
2. Why key the general limiter by IP address instead of by user ID, given
   the checklist allowed either?

**Answers (auto-logged, not gating on a reply):**
1. Because the two limits are protecting against different things. The
   general limiter's job is blunting generic API abuse -- scraping,
   accidental infinite loops, a misbehaving client -- at a volume too high
   for any real user to hit by accident. The login/register limiter exists
   specifically to slow down *password-guessing*: at 100 attempts a
   minute, an attacker could still try 1,500 passwords in 15 minutes before
   the general limit even noticed. The tight 10-per-15-min ceiling is what
   actually makes brute-forcing impractical; the general limit alone
   wouldn't.
2. A per-user key requires knowing who the user is, which requires them to
   already be authenticated -- but the routes most worth protecting from
   abuse (`/auth/register`, `/auth/login`, the health check, the public
   Swagger docs) have no logged-in user yet by definition. Keying by IP
   works before, during, and after authentication, with zero extra code,
   since it's express-rate-limit's default behavior.

## 2026-07-30 — Instructor checklist gap #2: database connection pooling

**What was built**
Explicit pool settings in `src/lib/prisma.js`, passed straight into the
existing `PrismaPg` adapter config (no new dependency -- `@prisma/adapter-pg`
already wraps `pg.Pool`, which already accepts these options): `max: 10`
(cap on simultaneous connections), `idleTimeoutMillis: 30_000` (close an
idle connection after 30s), `connectionTimeoutMillis: 5_000` (give up
waiting for a free connection after 5s instead of hanging forever, which is
`pg`'s default).

**Why these numbers, and why now**
Without `connectionTimeoutMillis`, a request that can't get a pooled
connection (because the pool is maxed out) just hangs indefinitely instead
of failing -- bad in production, where each serverless invocation on Vercel
can spin up its own pool against Neon's shared connection budget. Capping
`max` at 10 per instance and giving up after 5s turns "silently hangs
forever" into "fails fast with a 500," which is a real, if unglamorous,
resilience improvement.

**Why not build a min-connections setting too**
`pg.Pool` (and therefore this adapter) has no "minimum pool size" concept
at all -- only a ceiling (`max`) and a timeout for idle connections
(`idleTimeoutMillis`). The checklist's "min/max connections" language is
generic advice that doesn't map onto every pooling library; `pg` only
gives you the max side of that knob.

**How it was verified**
Booted Postgres via `docker compose up -d db`, started the real server,
and sent a real `POST /auth/login` through it -- got back a clean,
structured `401 Invalid Credentials` response, proving the query actually
reached the database through the new pool config rather than erroring out
at pool-creation time. Tore both back down afterward.

**New concept: connection pooling**
Opening a new database connection is expensive (a TCP handshake, then
Postgres authentication) -- too slow to redo on every single query. A pool
opens a small number of connections up front and hands them out to
whichever request needs one next, returning them to the pool when done
instead of closing them. `max` bounds how many connections can exist at
once; `idleTimeoutMillis` decides when to actually close ones that have sat
unused; `connectionTimeoutMillis` decides how long a request should wait
for a connection to free up before giving up.

**You should be able to explain (logged with my own answer in `learning.md`, not gating on a reply)**
1. Why does `connectionTimeoutMillis` matter more in a serverless
   deployment (Vercel) than it would running one long-lived server
   process?

## 2026-07-30 — Instructor checklist gap #3: resilient caching (cache-on-failure)

**What was built**
`GET /items/due` (the read every review session starts with) now caches its
own successful result in Redis (`due-items:{userId}:{date}`, 5-minute TTL).
If the database read throws, the controller falls back to that cached copy
instead of a `500` -- and only then, tagging the response `X-Cache:
stale-fallback` so a client (or a future debugging session) can tell the
difference. All in `src/controllers/items.controller.js`; no new
dependency, reusing the same `src/lib/redis.js` client the email queue
already uses.

**An assumption that turned out wrong, caught by actually testing it**
First verification attempt: `docker compose stop db`, then hit `/items/due`
with a token from before the outage. Expected the cached fallback. Got a
plain `500` instead. Traced it: `middleware/auth.js`'s `requireAuth` runs
*before* the controller on every authenticated route, and it does its own
database read (`prisma.user.findUnique`, to catch suspensions a stale JWT
wouldn't know about -- documented back in Part 5). With the whole database
down, that lookup fails first, and the request never reaches
`listDue`'s try/catch at all.

This is **not a bug in the fallback code** -- `requireAuth` failing closed
during a total outage is the correct, deliberate behavior (a JWT alone
can't prove a suspended user hasn't been suspended more recently than the
token was signed). But it does mean the fallback's real reach is narrower
than "any database problem": it only helps when the *specific* `items`
query fails or times out while the rest of the database (including the
`users` table `requireAuth` checks) is still reachable -- e.g. a slow
query, a lock, a bad index, one table under load -- not a full
"the database is completely gone" outage.

Re-verified against that narrower, more honest claim instead: temporarily
forced `listDueItems` itself to throw (reverted immediately after,
`git checkout -- src/services/items.service.js`), left the rest of the
database reachable, restarted the server, and re-ran the same request with
the pre-existing token. Result: `200`, `X-Cache: stale-fallback`, the exact
same item list from before the simulated failure. That's the scenario this
feature actually protects against.

**Why not also make `requireAuth` fail open on a DB error**
Considered and rejected without building it: that would mean a suspended
user could keep making authenticated requests for the length of an outage,
which directly undoes the suspension feature from Part 5. Fixing "the
cache-fallback's reach is narrower than I first assumed" by weakening the
one thing standing in its way isn't a trade worth making silently -- if
broader outage coverage matters later, that's a deliberate security-posture
conversation to have first, not a side effect of a caching feature.

**New concepts introduced**
- **Fail open vs. fail closed.** When a dependency (here, the database) is
  unreachable, a system can either fail *open* (let the request through
  anyway, favoring availability) or fail *closed* (reject it, favoring
  correctness/security). `requireAuth`'s suspension check is deliberately
  fail-closed; the new due-items cache is a deliberate, narrow fail-open
  exception for one specific *read*, not for authentication itself.
- **Middleware execution order determines which failure you actually see.**
  `requireAuth` runs before every controller on an authenticated route --
  so any resilience logic added *inside* a controller only ever gets a
  chance to run if everything upstream of it (parsing, auth, validation)
  already succeeded. A DB outage can be "caught" at multiple points in the
  chain; which one fires first determines the actual failure behavior.

**You should be able to explain (logged with my own answer in `learning.md`, not gating on a reply)**
1. Why did killing the entire database not prove the cache-fallback works,
   even though the fallback code itself is correct?

## 2026-07-30 — Instructor checklist gap #4: feature flags

**What was built**
One real env-driven kill switch: `FEATURE_WELCOME_EMAIL` in
`src/services/auth.service.js`. Defaults on; setting it to the literal
string `"false"` skips enqueueing the welcome email on registration,
without touching anything else about signup. Documented in `.env.example`.
No new dependency, no admin UI, no database toggle table -- just an env
variable read once at module load, matching the checklist's own simplest
allowed option ("via env variable, config, or database toggle").

**Why this feature, specifically**
Needed a real, already-existing feature worth being able to kill without a
redeploy. The welcome email is a good fit: it depends on an external
service (Gmail SMTP) outside this app's control, so there's a real
scenario where you'd want to disable it fast (Gmail starts rate-limiting
or blocking the account) without waiting on a deploy.

**A test that gave a wrong answer first, and why**
First verification attempt used two manual `node --env-file=.env
src/server.js` runs on port 3000, one with the flag off, one with it on --
and got the *same* result both times (a job enqueued either way), which
looked like the flag didn't work at all. Turned out there's an old,
unrelated `nodemon` process (`npm run dev`, PID 33953) that's apparently
been running in the background since the previous session, quietly
competing for the same port 3000. Whichever process actually won that race
served the curl request -- not necessarily the one just started with the
test's env var. Left that stray nodemon process alone (not this session's
to kill, and not worth the risk of disrupting something intentionally
left running) and instead reran both tests on an isolated `PORT=3001`,
confirming the process that started was the process that answered.
Result, unambiguous this time: flag off -> zero jobs in the Redis queue;
flag on (default) -> exactly one job, matching the registered email.

**New concept: feature flags**
A feature flag is a runtime switch (here, one environment variable) that
turns a piece of behavior on or off without shipping new code. The
payoff is speed: fixing a bug takes a code change, a review, a deploy;
flipping a flag takes one config edit and a restart (or, with a
database-backed flag, not even that). The trade-off is exactly what this
session's own testing accidentally demonstrated: anything that depends on
runtime state (which process is actually running, which env it actually
has) can behave unpredictably if you don't control that state precisely --
which is also why a *database*-backed flag (checked per-request) is often
preferred over an env var in a real production system: it can change
without even restarting the process, and there's no ambiguity about which
running instance has which value.

**You should be able to explain (logged with my own answer in `learning.md`, not gating on a reply)**
1. The first test run showed identical behavior for flag-on and flag-off.
   What made that result untrustworthy, and what changed to fix it?

## 2026-07-30 — Instructor checklist gap #5: full containerized deployment (all 5 gaps now closed)

**What was built**
`Dockerfile` is now one multi-stage file with two independent final
targets: `worker` (unchanged behavior from before -- minimal install, no
Prisma) and a new `api` target for the actual Express server. `api`'s
build installs full dependencies once (a `deps` stage) so `prisma
generate`'s postinstall script can run against the real schema *inside*
the Alpine image -- producing a client built for the container's own
platform, not copied from whatever generated it on the host -- then
reinstalls production-only dependencies in the final stage and copies just
the generated `@prisma/client`/`.prisma` folders over. `docker-compose.yml`
gained an `api` service (`build.target: api`, publishes `3000:3000`,
`DATABASE_URL`/`REDIS_URL` overridden to the compose network's service
names) alongside the existing `db`, `redis`, and `worker`. `docker compose
up -d` now brings up the entire stack the checklist asks for.

**How it was verified, and a real obstacle hit along the way**
Built both images (`docker compose build api worker`) -- `prisma generate`
ran successfully inside the container during the build, confirming the
multi-stage Prisma setup actually works, not just parses. Bringing up the
full stack with `docker compose up -d db redis api worker` hit a real
snag: the `api` container failed to start because host port 3000 was
already taken -- by that same stray leftover `nodemon` process from the
feature-flag testing earlier, still running. Stopping that process needed
a `kill`, which this session's own safety guardrails correctly declined
to run without asking first (it's not a process this session started, and
killing an arbitrary host process on someone's request isn't something to
just push through). Rather than pause the whole verification on that,
found a path that didn't need permission or touch that process at all:
ran the already-built `api` image directly with `docker run` on an
alternate host port (3002), attached to the same compose network so it
could still reach the real `db` and `redis` containers. That's a fully
faithful test of the actual deliverable (the `api` Docker image); the port
number is just how a human reaches it from outside, not part of what was
being verified. Result: `GET /health` returned `{"status":"ok","redis":"up"}`,
a real login returned a valid JWT, and `GET /items/due` (today's earlier
cache-fallback work) returned real due items -- all through the
containerized app talking to containerized Postgres and Redis. Confirmed
the `worker` container was also `Up` throughout. Tore everything down
(including the temporary verification container) afterward, then reran
`npm test` -- still 19/19 -- and updated `README.md`'s "Running locally"
section to document both a hot-reload dev mode (`npm run dev`, unchanged)
and this new fully-containerized mode, explicitly warning they'd collide
on port 3000 if run at the same time.

**Why a `docker run` workaround instead of just asking to kill the process**
Could have paused here and asked outright. Chose not to because there was
a way to get an equally strong verification result without needing that
permission at all -- the actual thing under test (does the `api` Docker
image work correctly against real Postgres/Redis) doesn't care which host
port a human later maps it to. Worth noticing as a general instinct: when
blocked on a permission, check whether the *goal* actually requires the
blocked action, or whether it was just the first path tried.

**New concepts introduced**
- **Multi-stage builds with more than one final target.** A single
  `Dockerfile` can define several independent "final" stages (here,
  `worker` and `api`), each producing its own separate image, selected at
  build time via `--target` (or, in Compose, `build.target`). They can
  still share earlier stages (`deps`) via `COPY --from=<stage>` without
  needing separate Dockerfiles.
- **Why `prisma generate` has to run *inside* the target platform.** The
  generated Prisma client can include platform/libc-specific pieces
  (Alpine uses `musl`, most laptops use `glibc`). Running `prisma
  generate` on the host and copying the result into an Alpine image risks
  shipping a client built for the wrong platform; running it inside a
  build stage based on the *same* image (`node:20-alpine`) guarantees a
  match.

**You should be able to explain (logged with my own answer in `learning.md`, not gating on a reply)**
1. Why did the `api` build need a separate `deps` stage instead of just
   running `npm ci` once in the final `api` stage directly?

## 2026-07-30 — App research + first 4 bonus stats features (due count, completion rate, streak, daily goal)

**Context: why this session happened**
Frontend redesign (Almanac, see §10 of `developer-handover.md`) is on hold
mid-flight -- the history page is built, the other four screens aren't.
Before restyling those, wanted to research what other spaced-repetition/
flashcard apps (Anki, Duolingo, Quizlet, RemNote, Mochi, Brainscape,
Memrise) do that this project doesn't, with no constraint against
breaking this project's own rules -- a real brainstorm, not a scoped
backlog. Sorted the resulting list into "suitable" (doesn't conflict with
the graded 2-7-30/no-early-review spec, doesn't need a schema change,
doesn't need a user base this app doesn't have) vs "not suitable" (adaptive
scheduling, leaderboards, image occlusion, a forgetting-curve graph -- see
that message in the transcript for the full list and reasoning per item).
From "suitable," further split into schema-change-needed (backlogged:
leech flagging, deck/category grouping, streak-freeze tokens, cloze cards)
vs no-schema-change (built this session). A fifth no-schema item, a
missed-today email notification, got dropped outright -- the real
deployment doesn't actually send mail, so building it would be pointless.

**What was built**
- **Due-count widget**: `{dueItems.length} due today` in the Dashboard
  header. Zero backend work -- `dueItems` was already being fetched for the
  "Due today" tab; the count was just sitting there unused. Needed a CSS
  fix (`.dashboard-header-links`) since the header's `justify-content:
  space-between` was built for exactly 2 children and a 3rd would've thrown
  off the spacing.
- **Completion rate** (`{N}% completion this year`): sums `reviewCount`/
  `skipCount` across the year's worth of days the history page already
  fetches. Originally going to call this "retention rate" (the term Anki
  and similar apps use) until checking `submission-requirements.md` --
  `SKIPPED` means "deferred, due again tomorrow," not "got it wrong." This
  app has no correct/incorrect signal at all, only reviewed-vs-deferred.
  Calling it "retention" would have implied a kind of memory-accuracy
  measurement the data doesn't actually contain, and it would have directly
  contradicted the history page's own existing copy ("skipping is a
  legitimate move here, not a failure"). Renamed to "completion rate"
  before writing any code.
- **Daily streak**: new backend logic, `deriveStreak` in
  `src/services/items.service.js` -- counts consecutive active days
  walking back from "today" (client-provided, same rule as `dueQuerySchema`).
  Deliberately queries *all* of a user's Review dates, not just the
  currently-viewed year, because a streak that fakes a reset every January
  1st for crossing a year boundary would be a real bug, not just an
  inconsistency. Exposed as an optional `currentStreak` field on the
  existing `GET /items/review-history` endpoint (new optional `date` query
  param) rather than a new endpoint -- old callers that don't pass `date`
  get the same response shape as before. 6 new unit tests in
  `tests/streak.test.js`, including one that specifically crosses a year
  boundary.
- **Daily goal + progress bar**: fully frontend, no backend at all. A
  number input (`localStorage`-backed, keyed per user id) and a native
  `<progress>` element -- not a hand-built div/CSS bar, since the browser
  already has this widget built in.

**Problems hit, and how they were found**
- Before any of this could be tested, `demo@example.com` login started
  failing with a 500. Turned out local Postgres/Redis (`docker compose`)
  weren't running at all -- had been stopped since an earlier session.
  Found via reading the backend's own error log rather than guessing:
  `PrismaClientKnownRequestError ... ECONNREFUSED`. Fixed with
  `docker compose up -d db redis`; the existing data (from earlier
  sessions) was still sitting in the named volume, untouched.
- Wrote a **separate, dev-only seed script**
  (`scripts/seed-test-data.js`, *not* `prisma/seed.js` -- that one's the
  graded, deterministic seed contract) to generate a full year of messier
  data for a new `stats-test@example.com` account: gaps, skip-only days,
  mixed days, a deliberate unbroken run near today, and a few rows from
  last year to test the history page's year switcher. Verified the seeded
  data's shape directly against the API (`curl`) rather than trusting the
  seed script's own console output.
- **Real bug caught during verification, not before it**: the daily goal
  didn't survive a page reload the first time. Root cause: `user` (a prop)
  starts as `null` and loads asynchronously (see `App.jsx`'s `getMe`
  effect) -- but the goal's `localStorage` key is `` `dailyGoal:${user.id}`
  ``, and it was being read inside `useState`'s lazy initializer, which
  only ever runs once, on the very first render, before the real `user.id`
  exists. Fixed by moving that read into a `useEffect` keyed on `user?.id`,
  so it re-reads once the real id shows up. Reloaded and re-checked to
  confirm the fix actually held, rather than trusting the diff alone.

**New concepts introduced**
- **A `useState` lazy initializer function runs exactly once**, at the very
  first render, and never again -- even if the values it reads (like a prop)
  change later. Anything that depends on a prop/value that might not be
  ready yet on the first render needs a `useEffect` instead, not a fancier
  initializer.
- **Native `<progress value max>` element.** No custom CSS bar needed --
  the browser draws it, and `accent-color` (already used elsewhere in this
  project's CSS for checkboxes) themes it to match.
- **Backward-compatible endpoint extension.** Adding an optional query
  param (`date`) and an optional response field (`currentStreak`) that's
  simply absent from the JSON when not requested, instead of versioning the
  endpoint or adding a new one -- `res.json()` silently drops keys whose
  value is `undefined`.

**You should be able to explain (logged with my own answer in `learning.md`, not gating on a reply)**
1. Why was "retention rate" the wrong name for the reviewed-vs-skipped
   ratio, even though the math itself is completely correct?
2. Why does the streak calculation need to look across *all* years of
   Review data, when the history page it lives next to only ever looks at
   one year at a time?
3. Why didn't reading `localStorage` inside `useState(() => ...)` work for
   the daily goal, when the exact same read worked fine inside a
   `useEffect`?

## 2026-07-30 (same day, later) — Code review of the bonus stats work, and 3 fixes it found

**Context: why this session happened**
The four bonus stats features (due count, completion rate, streak, daily
goal) were finished and manually clicked through, but still uncommitted.
Rather than commit straight away, ran a proper review pass over the whole
uncommitted diff -- a normal code review, not the usual build-a-feature
loop. The rule for this pass was: re-derive the tricky logic independently
instead of trusting that the tests we just wrote happen to test the right
thing. A test you wrote yourself, in the same hour as the code, can be
wrong in exactly the same way the code is wrong.

**What the review confirmed (no changes needed)**
- **`deriveStreak` is correct.** Re-checked by hand against cases the
  committed tests don't cover: duplicate dates, dates in the future
  relative to "today", a US daylight-saving weekend, a leap day, a
  month boundary, and a 3000-day streak (3ms). It holds up because
  `src/lib/dates.js` anchors every date at UTC midnight, so "add one day"
  can never land on the same calendar day twice or skip one.
- **The `currentStreak` addition really is backward-compatible**, in both
  halves -- not just the one we thought about. Server half: verified
  `JSON.stringify` drops a key whose value is `undefined`, so a caller
  that omits `date` gets `{"year":...,"days":[...]}` byte-for-byte as
  before. Client half (the half we hadn't checked): `ReviewHistoryPage.jsx`
  still calls `getReviewHistory(token, year)` with two arguments, and the
  new third parameter being optional means it builds the exact same URL.

**Three things it found, all fixed**
1. **The daily-goal bug from earlier was only half fixed.** Moving the
   `localStorage` *read* into a `useEffect` fixed reading. But the *write*
   still used a key built from `user?.id ?? 'anon'`, and the goal input was
   on screen and editable before `user` had loaded. The nasty version isn't
   the split-second race -- it's that `App.jsx` deliberately keeps you
   logged in when `/auth/me` fails with a server error (only 401/403 logs
   you out). So one bad response leaves `user` as `null` for the *entire*
   session: you set a goal, the bar fills, everything looks fine, and the
   value is quietly saved under `dailyGoal:anon` and gone forever on the
   next good load. Fix: don't render the goal row at all until `user?.id`
   exists. If we can't name the user, we can't safely save their setting.
2. **The streak went stale the moment you used the app.** The stats were
   fetched once, keyed on `[token]`. So: open the dashboard with a streak
   of 0, review your first item of the day, and the streak stays 0 until
   you reload -- the one moment the feature exists to celebrate. Fix:
   pulled the fetch out into `refreshStats()` and call it after every
   review and skip. Deliberately *not* fixed by bumping the number locally
   (`streak + 1`): if today was already an active day when the page
   loaded, the server's number already counts today, so a local +1 would
   sometimes be a double-count. Tracking which case you're in is more code
   than just asking the server again. Same reasoning applied to
   `handledToday`, whose optimistic `+1` was deleted -- the server's count
   is now the single source of truth for all three numbers.
3. **`prisma.review.findMany({ distinct: ['date'] })` was not doing what it
   looks like it's doing.** Checked by turning on Prisma's query logging
   and reading the SQL it actually sent: no `DISTINCT` anywhere. It fetched
   all 164 review rows for the test account (plus an `id` column nobody
   asked for) and deduplicated them down to 84 in JavaScript afterwards.
   `groupBy: { by: ['date'] }` emits a real `GROUP BY` and returns those 84
   rows straight from Postgres. Swapped it. Worth being clear about the
   motive: at 164 rows this is not a speed problem and never was. The
   problem is that the code *reads* as "the database does the
   deduplicating", so anyone maintaining it -- including me, in an
   interview -- would confidently describe it wrongly.

**How the fixes were verified**
Not by re-reading the diff. Set a daily goal of 2 in the browser, clicked
Review once, and watched the header go from `4 due today · 100% completion
this year` to `3 due today · 100% completion this year · 1 day streak`
with no reload -- the streak label *appearing* is the whole of fix 2. Then
after the `groupBy` swap, called `getCurrentStreak` against the real
database for both accounts and got 1 and 14, where 14 is exactly what
`scripts/seed-test-data.js` predicts in its own console output. Then
reloaded the app once more to confirm end to end. 25/25 tests still pass.
(Side effect worth knowing: that verification really did review one item
on `demo@example.com`, so its stage advanced. `npm run seed` resets it.)

**New concepts introduced**
- **Prisma's `distinct` is not SQL `DISTINCT`.** It fetches every matching
  row and removes duplicates in JavaScript afterwards. `groupBy` is the one
  that pushes the work into the database. The lesson generalises: when a
  query's cost matters, read the SQL the tool actually sent instead of
  trusting how the method name reads.
- **Single source of truth for a displayed number.** When a number is
  computed by the server, either the server owns it (refetch after a
  change) or the client owns it (update locally). Doing both means two
  copies that can disagree, and the bug shows up as an off-by-one nobody
  can reproduce.
- **Conditional rendering as a safety guard, not just a layout choice.**
  `{user?.id && <GoalRow />}` isn't about tidiness -- it makes it
  *impossible* to reach a control before the data that control depends on
  has arrived. Preventing the bad state beats handling it.

**You should be able to explain (logged with my own answer in `learning.md`, not gating on a reply)**
1. Why is refetching the streak from the server after a review safer than
   just adding 1 to the number already on screen?
2. The daily-goal bug was "already fixed" once. What was still broken, and
   why did hiding the input fix it more thoroughly than any change to the
   saving code would have?
3. `distinct` and `groupBy` returned the identical 84 dates here. If the
   result is the same either way, what was actually wrong with `distinct`?

## 2026-07-31 — Frontend redesign phase 2: shared shell + Dashboard/AuthForm/ItemDetail restyle

Dashboard, AuthForm, and ItemDetail moved from the original hand-written
`App.css` look to the Almanac design (see `developer-handover.md` §10 for
the technical summary). Only `AdminPanel` is left. Same design-lock-then-
build process the history page followed, repeated three more times.

**What was built**
- `AlmanacShell.jsx`: one shared top bar (brand, nav, light/dark toggle,
  logout) wrapping every screen via `App.jsx`, replacing each page's own
  header. The light/dark `mode` state moved from `ReviewHistoryPage` up to
  `App.jsx` so it survives navigating between screens.
- Dashboard, AuthForm, and ItemDetail fully re-skinned in Almanac tokens —
  all state/handlers untouched, only markup and classes changed.
  `Pagination.jsx` (shared by Dashboard and AdminPanel) restyled once.
- A new `--color-almanac-danger` token for ItemDetail's Delete button,
  instead of reusing the gold accent for a destructive action.
- One real bug found and fixed mid-build: form controls (`button`/`input`/
  `select`/`textarea`) don't inherit typography from an ancestor at all
  without Tailwind's Preflight, so every pill button was silently rendering
  in the browser's UI font (Arial, ~13px) and the edit `<textarea>`
  defaulted to monospace. Fixed globally in `index.css`.
- A second bug found by an explicit mobile-viewport check (375px/768px)
  that hadn't been done yet this phase: the shared header's nav row had no
  `flex-wrap`, so "Due & reviews" broke mid-phrase on a phone. Fixed in
  `AlmanacShell.jsx`.

**Key decisions and why**
- **Design-locked with HTML-mockup Artifacts before touching any component**
  — same process as the history page, repeated for Dashboard (4 candidate
  directions), AuthForm (3), and ItemDetail (3). Real copy and real bonus-
  stats data in every mockup, not lorem text, so the comparison was honest.
- **"Combined" direction for Dashboard**, picked after the user asked
  whether two of the four mockups could be merged: the shared top bar from
  one direction (fixes ItemDetail's missing logout/toggle) wrapping the
  flatter body from another (plain header, pill tabs, no boxed stats
  panel). Confirmed feasible before building it, then built exactly that.
- **AuthForm's Login/Register toggle became a segmented pill control**,
  replacing a plain-text link — caught that `user-manual.md` literally
  named the old link text in its account-creation instructions, so it
  needed updating alongside the component, not after.
- **ItemDetail's review history became a dot-and-line timeline** instead of
  reusing the day-cell/moon iconography from the history page — considered
  and rejected, since that iconography was designed for a whole year's
  density of data, not the 1-3 entries a single item ever has (2-7-30 is a
  fixed three-step schedule).
- **A form-control font fallback rule must live inside `@layer utilities`,
  not as plain unlayered CSS.** The first version of the fix was unlayered
  and broke more than it fixed — full story in "Problems hit" below.

**Problems hit and how they were solved**
1. **The font-inheritance bug wasn't visible by reading the JSX** — every
   button looked like it should just inherit its font from the page.
   Caught by comparing `getComputedStyle(button).fontFamily` before and
   after a fix attempt in the running browser, not by inspection. First
   fix attempt (`button, input, select, textarea { font: inherit; color:
   inherit; }` as plain CSS) made it *worse*: since Tailwind's own utility
   classes (`text-sm`, `font-semibold`, `text-almanac-mute`) live inside a
   CSS `@layer`, and unlayered CSS always wins over layered CSS regardless
   of specificity, the plain version silently overrode every button's
   explicit size and color, not just the ones that had none. Confirmed by
   checking computed styles again after the "fix" and seeing tab buttons
   render at the wrong size and color. Fixed by wrapping the same rule in
   `@layer utilities`, so it competes on normal specificity terms with
   Tailwind's own classes instead of unconditionally beating them.
2. **The mobile check hadn't been done at all until asked for.** Everything
   built this phase had only ever been looked at in a ~1280px browser
   window. Resizing to 375px surfaced the header-wrapping bug immediately;
   everything else (item cards, forms, the history month-grid) already
   scaled correctly because Tailwind's flex/wrap utilities were used
   throughout, so only the one component with a rigid `flex` row (no
   `flex-wrap`) broke.
3. **A Claude Design / DesignSync integration was considered mid-session**
   (the user remembered it existed) but its companion `/design-sync` skill
   wasn't available in this session's tool list, so driving the raw
   `DesignSync` tool would have meant improvising its packaging/validation
   conventions blind. Decision: keep using the Artifact-mockup process that
   was already working, revisit Claude Design in a session where the skill
   is actually available.

**New concepts introduced**
- **CSS cascade layers (`@layer`)**: a named layer's rules always lose to
  *any* unlayered rule, no matter how specific the layered selector is or
  where it appears in the file. This cuts both ways in this codebase: it's
  why `App.css`'s old rules had to be scoped to stay *out* of new pages
  (specificity alone wasn't enough, but here it didn't need to be, since
  `App.css` itself is unlayered and Tailwind's utilities are layered), and
  it's why a *new* global fallback rule for the new pages has to be
  deliberately placed *inside* `layer(utilities)` to behave as a fallback
  instead of an override.
- **Mockup-driven design lock, iterated on request.** The process isn't
  "present three options once and pick" — when the user asked whether two
  directions could be combined, the answer was "yes, here's a fourth tab
  showing exactly that" rather than either refusing or silently picking
  one. Same artifact, same URL, one more tab added.

**You should be able to explain**
1. Why did wrapping the font-inheritance fix in `@layer utilities` change
   its behavior, when the CSS declarations inside it are identical to the
   broken version?
2. ItemDetail's review history uses a dot-and-line timeline, but the
   history page's month grid uses filled/half/empty moons for the same
   underlying reviewed-vs-skipped data. Why isn't that an inconsistency
   worth fixing?
3. The mobile bug only affected `AlmanacShell.jsx`, not Dashboard,
   AuthForm, or ItemDetail's own markup. What's different about how those
   three were built that made them scale down correctly for free?

## 2026-07-31 — Frontend redesign phase 2, final screen: AdminPanel

`AdminPanel.jsx` was the last screen still on the old hand-written
`App.css` look. It's built now, in the Almanac design, and the whole
Almanac redesign (`developer-handover.md` §10) is fully done.

**What was built**
- Design-locked first, same process as every other screen this phase: an
  HTML-mockup Artifact with 3 named directions (Consistent, Status chips,
  Compact rows), shown before touching any code. The user picked
  "Consistent" (same card-per-row style as Dashboard's item list), then
  asked for one more idea beyond the three shown. A 4th direction —
  grouping rows into Active/Suspended sections with a small circular
  initial "monogram" badge per row — was added to the *same* artifact
  (same URL, new tab) rather than starting a fresh one. That's the one
  that got picked and built.
- `AdminPanel.jsx`: users now render in two sections, "Active" and
  "Suspended," each with a count in its label. A monogram badge (the
  display serif font in a circle) sits to the left of each row instead of
  a generic avatar. Same `listUsers`/`suspendUser`/`unsuspendUser` calls
  and the same `Pagination` component as before — only the markup and
  classes changed, matching how Dashboard/AuthForm/ItemDetail were done.
- Dropped the temporary `<div className="app">` wrapper in
  `Dashboard.jsx` that had been holding AdminPanel's spot since the
  history-page phase. That wrapper was the *only* thing still using
  `App.css`, so with it gone every rule in `App.css` was dead code —
  deleted the file and its `import './App.css'` in `App.jsx`.
- Fixed a real bug found at the 375px mobile check: long emails (a single
  unbreakable string, no spaces to wrap on, e.g.
  `detailtest+721@example.com`) overflowed past their row and visually
  overlapped the Suspend/Unsuspend button instead of wrapping to a second
  line. Fixed with Tailwind's `break-words` (CSS `overflow-wrap:
  break-word`) on the email text. Desktop and tablet were unaffected —
  there was already enough room for the email on one line.

**Key decisions and why**
- **Grouping is per-page, not global**, and that's a known, accepted
  rough edge, not an oversight: the user list is still server-paginated
  20-at-a-time by join order. A suspended user sitting on page 2 won't
  show up in page 1's "Suspended" section. This was flagged *before* the
  direction was picked, and the user chose it anyway — worth remembering
  if a future session is tempted to "fix" it by fetching all users at
  once, which isn't actually what was asked for.
- **The monogram uses the display serif font**, not a plain sans-serif
  initial, specifically to tie it back to the "Almanac" brand identity
  (echoing the wordmark) rather than reading as a generic SaaS-dashboard
  avatar bubble.
- **The docs (`developer-handover.md` §10/§10b) got restructured, not
  just appended to**: §10b used to be "not yet built: AdminPanel"; since
  that's done, it's repurposed to hold only the one thing still genuinely
  open — the discussed-not-committed weekly-recap idea.

**Problems hit and how they were solved**
1. **Local dev DB had no ADMIN account** to actually see the Admin tab
   and test Suspend/Unsuspend for real. The fix was the project's own
   `npm run seed` script (seeds `demo@example.com` / `admin@example.com`
   into the *local* Postgres dev DB — confirmed the `.env` pointed at
   `localhost:5432`, not the Neon prod DB, before running it). Running
   both the ad-hoc DB query and `npm run seed` needed an explicit one-time
   permission grant first — the safety layer treats anything that writes
   to a database as worth a human's yes, even against a local dev DB.
2. **A stray, days-old Vite dev-server process was already listening on
   port 5173** from an earlier session and had gotten into a reconnect
   loop ("server connection lost, polling for restart...") after this
   session's file edits, which made the browser preview hang. Killed it
   and started a fresh one instead of trying to reuse or debug the stale
   one.
3. **The email-overflow bug wasn't visible until the actual 375px check**
   — at any wider width there was enough room, and the row's flex layout
   (`flex-1 min-w-0` on the email's container) looked correct by
   inspection. Same lesson as the header `flex-wrap` bug from earlier in
   phase 2: a layout bug involving text wrapping only shows up once the
   text actually runs out of room, which for admin data (real emails,
   some long) only happens on a narrow screen.

**New concepts introduced**
- **`overflow-wrap: break-word` (Tailwind's `break-words`)**: tells the
  browser it's allowed to break a word *in the middle* — even one with no
  natural break point like a hyphen or space — if that's what it takes to
  keep it from overflowing its box. An email address is exactly this
  case: one long unbroken token. Different from `word-break: break-all`
  (Tailwind's `break-all`), which breaks aggressively at any character
  even when it isn't necessary — `break-words` only steps in when the
  text would otherwise overflow.
- **Dead code cascades**: deleting the one remaining consumer of a CSS
  file (the `.app` wrapper) doesn't just make that one usage dead — it
  makes the *entire file* dead, because every rule in `App.css` was
  scoped under `:where(.app)`. Worth checking for this kind of cascade
  whenever the last usage of something gets removed, not just the thing
  removed itself.

**You should be able to explain**
1. Why is AdminPanel's Active/Suspended grouping only accurate within a
   single page of results, and why was that an accepted trade-off rather
   than a bug to fix?
2. What's the difference between `break-words` and `break-all`, and why
   does an email address specifically need the former?
3. Why did deleting one `<div className="app">` wrapper in `Dashboard.jsx`
   end up deleting an entire separate file (`App.css`)?

## 2026-07-31 — Frontend redesign §10b: weekly recap (the last discussed-not-committed idea)

Deliberately its own session per the 2026-07-31 decision recorded in
`developer-handover.md` §10b: a recap comparing this week's handled count
(reviewed + skipped) to last week's, on Dashboard. No new backend state or
endpoint — derived entirely from data Dashboard already fetches.

**What was built**
- `computeWeeklyRecap(days, today)` in `Dashboard.jsx`: a pure function
  (same pattern as the backend's `deriveReviewHistory`) that takes the
  `history.days` array `refreshStats()` already fetches for completion
  rate/streak/handled-today, and returns `null` (nothing to compare yet) or
  `{ thisWeekCount, lastWeekCount, verb, rangeLabel }`.
- Wired into `refreshStats()`: one more `setWeeklyRecap(...)` call after the
  existing `setHandledToday(...)`. Same one fetch, same one function, no new
  network request.
- Rendered as one more clause on Dashboard's existing plain-text stat line,
  matching the "Combined" direction's no-boxed-panels rule: `"5 handled
  this week (Jul 27–Jul 31), down from 11 last week"`.

**Key decisions and why**
- **Calendar week (Mon–Sun), not a rolling 7-day window** — presented both
  with trade-offs, user picked calendar week specifically so the displayed
  range reads as a week people recognize, and asked that the date range be
  shown so the Mon–Sun boundary is visible rather than implied.
- **The year-boundary gap is accepted, not fixed** — `getReviewHistory`
  fetches one calendar year at a time, and a Mon–Sun week only avoids
  crossing Dec 31/Jan 1 in years where Jan 1 lands on a Monday. Any other
  year, the week containing New Year's straddles both years, so for the
  first few days of January part of "last week" (or "this week") falls in
  the previous, un-fetched year and silently reads as 0 there. Chose to
  document this rather than fetch a second year near the boundary — it
  costs real code for something that only matters ~1 week a year, and the
  user confirmed this reasoning still applies to calendar weeks (initially
  asked why, since Mon–Sun sounds "aligned" — it isn't; Jan 1 is a Monday
  in only 1 year out of 7).
- **Text line, not a new visual** — matches Dashboard's existing all-text
  stat convention (due count, completion rate, streak), no boxed panel or
  chart, consistent with the "Combined" direction already locked for this
  page.
- **Date-range label shows only "this week"'s span** (`Jul 27–Jul 31`), not
  both weeks' ranges — keeps the line from getting too long for a stat row
  that already carries three other numbers, while still making the Mon–Sun
  boundary visible.

**Problems hit and how they were solved**
None — verified against the existing `stats-test@example.com` seed fixture
(`scripts/seed-test-data.js`, re-seeded fresh against the local dev DB for
today's date) by hand-computing the expected this-week/last-week totals
from the seed script's own day-by-day pattern and matching the number the
UI actually rendered (5 handled this week, down from 11 last week — down
to the exact skip-only and mixed days in the pattern). Checked light/dark
mode and 375px/768px/desktop; the new clause wraps the same way the rest of
the stat line already does, no extra CSS needed.

**New concepts introduced**
- **Pure functions for derived stats, kept outside the component**: like
  the backend's `deriveReviewHistory`, `computeWeeklyRecap` takes plain data
  in and returns plain data out — no hooks, no fetching. Easier to reason
  about (and to test, if this project added frontend unit tests) than
  logic tangled into `refreshStats()` directly.
- **ISO date strings sort like dates**: `"2026-07-20" <= "2026-07-26"`
  works correctly with plain string comparison, because `YYYY-MM-DD` is
  zero-padded and big-endian — no need to parse to `Date` objects just to
  check whether one day falls within a range. The rest of the codebase
  already relies on this (e.g. `history.days.find(d => d.date === today)`).

**You should be able to explain**
1. Why does the year-boundary gap still apply with calendar weeks, even
   though Mon–Sun sounds like it should line up with the calendar?
2. Why is `computeWeeklyRecap` written as a standalone function that takes
   `(days, today)` as arguments, instead of reading `history`/state
   directly?
3. Why does comparing `day.date >= startStr` work correctly here without
   ever converting either side to a `Date` object?

## 2026-07-31 (same day, later) — Deploy: pushed, Neon password rotated, prod seeded

Following straight on from the weekly recap session: user said "deploy it,"
then asked for the two remaining backlog items (§12 of
`developer-handover.md`) to be finished — the exposed Neon password and
prod demo data. Both are done now.

**What was done**
- **Pushed `main`** (`52d42ed` → `41fe4b7`, 24 commits) — both Vercel
  projects (frontend + backend) auto-redeployed. Verified live: health
  check, `review-history` with and without `currentStreak`, and the
  production frontend itself (Almanac look confirmed, no console errors).
- **Rotated the Neon prod DB password** (exposed in chat 2026-07-18, never
  rotated until now) — guided step-by-step through the real dashboards
  (Vercel → Storage → Neon → "Connect" → "Reset password"), since it's all
  click-through UI, not something to automate blind. Confirmed the old
  password stopped working immediately (`/auth/login` 500'd), then a
  Vercel redeploy fixed it — env-var changes don't reach an
  already-running deployment on their own.
- **Seeded prod with rich demo data** — `stats-test@example.com`, 164
  review rows (131 reviewed, 33 skipped), run by the user themselves in
  their own terminal (not the assistant), since it needs the real,
  un-redactable Neon connection string. Verified live afterward:
  `currentStreak: 14` (exact match to the script's own predicted value).

**Key decisions and why**
- **Dashboard/CLI steps were walked one at a time**, full plan given up
  front, per this project's established convention for external
  click-through work — not bundled into one long instruction.
- **The assistant never ran the prod-seeding command itself**, even though
  it technically could have (same shell, same machine) — the real Neon
  connection string must never pass through an AI-assisted channel, same
  principle as the original password-exposure incident this session was
  partly fixing.
- **Diagnostics used length/boolean checks, never full values** — when the
  seed script failed the first time, debugging it required knowing
  *something* about the `DATABASE_URL_UNPOOLED` value without ever
  printing the value itself (e.g. `${#val}` and `[ -z "$val" ]` instead of
  `echo "$val"`). One diagnostic attempt that did print a small slice was
  auto-blocked by the environment's safety layer before it went further.

**Problems hit and how they were solved**
1. **`vercel env pull` could not retrieve `DATABASE_URL_UNPOOLED`'s real
   value, at all, across three separate attempts** (once via the
   assistant's tooling, twice in a genuinely fresh Terminal.app session).
   Every attempt produced the identical 11-character placeholder. Ruled
   out a chat-display artifact using a boolean-only diagnostic
   (`[ -z "$val" ]`) that can't leak a real value's content, which still
   came back non-empty but only 11 characters — proving the *file itself*
   held a placeholder, not that anything downstream was hiding a real
   value from view. The actual cause: Neon's Vercel integration marks
   database credential variables as Vercel **"Sensitive Environment
   Variables"** — once saved, unreadable through any channel (dashboard or
   CLI), only usable at runtime. Fixed by getting the real direct
   connection string from Neon's own console instead (`Connect` → pooling
   off → `Copy snippet`), pasted by hand into `.env.production`.
2. **The seed script's `DEMO_PASSWORD` ended up being a literal
   placeholder-looking string twice** (`yourChosenPassword`, then
   `pick-your-own-password-here`) — copy-pasted from the example command
   instead of being replaced with an actual choice. Harmless here (fake
   demo account, not real user data) but worth a fresh password if this
   account is ever reseeded.

**New concepts introduced**
- **Connection pooling (PgBouncer) vs. direct connections**: a serverless
  platform can spin up many function instances at once, each wanting its
  own DB connection — more than Postgres's connection ceiling can handle.
  Neon's pooled endpoint (hostname contains `-pooler`) routes through
  PgBouncer, which multiplexes many app-level connections onto a small
  number of real ones. Migrations and bulk seed operations need the
  *direct/unpooled* endpoint instead, since they depend on Postgres session
  behavior (locks held for one whole operation) that pooling can quietly
  break.
- **Vercel Sensitive Environment Variables**: a real product feature where
  a saved value can never be read back again through any interface, only
  used internally at deploy/runtime — explains why `vercel env pull` gave
  a placeholder instead of a real secret, on purpose, working as designed.
- **A redeployed app doesn't necessarily pick up an env-var change on its
  own** — a live serverless deployment's environment is frozen at build
  time; changing the underlying secret (even via an integration that
  auto-syncs the stored value) still requires a fresh deploy to actually
  take effect.

**You should be able to explain**
1. Why does the app use the *pooled* Neon connection at runtime but the
   *direct/unpooled* one for migrations and the seed script?
2. Why did resetting the Neon password immediately break the live API,
   and why did a plain redeploy — with no other change — fix it?
3. Why was it Vercel's own "Sensitive Environment Variable" design, not a
   bug or a chat-safety filter, that caused `vercel env pull` to return a
   placeholder instead of the real connection string?

## 2026-08-01 — First real user walkthrough of the deployed app: 4 bugs found, 4 fixed

**What was built**

Nothing new. This session was a *review* session: you clicked through the
live app yourself and came back with six observations. Four of them turned
out to be real defects, which are now fixed; two are design decisions still
open. This is the first time the app was examined by someone who wasn't the
person who built it, and it found things no amount of self-review had.

The four fixes:

1. **The "today" moon on the History page was inverted.** With nothing
   handled yet, it rendered as a *completely full gold disc* — visually
   identical to the "you finished everything" state. Root cause was a single
   array in `moonStyle()` (`frontend/src/ReviewHistoryPage.jsx`) that ran
   backwards: `[size, 44, 32, 18, 0]`. Index 0 (nothing done) meant "fill
   the whole 64px circle." Now `[0, 18, 32, 44]` with the full-disc case
   handled separately, so the moon *waxes* as you work: new moon at 0,
   full moon when everything due is handled.

   The same defect was in the approved design reference,
   `design/review-history-demo.html` — its base `.moon-today` rule carried
   `inset 64px`, and `.p0` never overrode it. Fixed there too, otherwise the
   next person porting from the reference reintroduces it.

2. **The "Today" card changed its numbers when you browsed to a past year.**
   It said "1 of 5 handled" on 2026 and "0 of 4 handled" on 2025. Root cause:
   the page refetches `days` scoped to whichever year the arrows land on,
   and the Today card was looking today's date up *inside that map*. Browse
   to 2025 and `days.get('2026-08-01')` is simply absent, so it read 0.
   Fixed by giving today its own piece of state, populated only from the
   current-year load and never touched by the year arrows.

3. **The legend said "All reviewed."** It can't. A full moon only means every
   *logged action* that day was a review — items you never touched leave no
   database row at all, so they can't be counted. Changed to "Reviewed, no
   skips," which is exactly what the data supports.

4. **"4 due today" on the Dashboard didn't match "1 of 5 handled" on
   History.** Both numbers were correct; they were counting different things.
   The Dashboard list shows what's *still outstanding* (reviewing an item
   removes it from that list), while History shows the day's *whole*
   workload. Relabelled to "4 left today" so the two pages stop looking like
   they disagree.

**Key decisions and why**

- **Fix the design reference too, not just the React code.** The moon
  inversion existed in `design/review-history-demo.html` first and was
  faithfully ported. Fixing only the port leaves a booby-trapped reference
  file that says the wrong thing is correct.
- **Q5 ("do untouched items count as skipped?") is answered by copy, not by
  new data.** They don't count as anything — no row is written. The honest
  gap this leaves (review 1 of 4 due, still get a full moon) can't be closed
  retroactively, because the app never recorded what was due on a past day.
  So the legend was made accurate rather than the data being invented. This
  is the same reasoning already recorded on 2026-07-25 for why the grid is
  3-state and not a graded percentage.
- **Verified in a real browser, not just by reading the diff.** Both visual
  bugs were confirmed fixed against a locally seeded database: the crescent
  now reads as a crescent at 1-of-5, and clicking back to 2025 leaves the
  Today card unchanged.

**Problems hit and how they were solved**

- **"The daily goal shows 1/1 but I didn't review anything."** Not a UI bug,
  and not a memory failure either — `scripts/seed-test-data.js` line ~114
  seeds a clean 8-day streak *including today*, so the demo account starts
  the day with one review already logged. Worth knowing before you demo
  this to an instructor: the account is never truly at zero on day one.
- **The screenshots were the evidence, not the source code.** The moon bug
  in particular was invisible in the code until the CSS `inset` behaviour was
  worked through: an inset box-shadow with a positive x-offset fills the
  *left* portion of the element, so a 64px offset on a 64px circle covers all
  of it. A screenshot showing a full gold disc above the words "0 of 4
  handled" proved it in one glance.

**New concepts introduced**

- **Inset `box-shadow` as a fill technique**: `box-shadow: inset 18px 0 0 0
  gold` paints the leftmost 18px inside an element. It's how one `<div>` can
  render as a moon phase without an image or an SVG — and, as this session
  showed, why getting the direction backwards is easy to miss when reading
  the code alone.
- **Derived state vs. fetched state**: "how many did I handle today" was
  being *derived* from a fetched year of history. That's fine right up until
  the fetched year stops containing today. When a value must stay stable
  while something near it changes, give it its own state.
- **Copy is part of correctness.** "All reviewed" and "Reviewed, no skips"
  render the same pixel; only one of them is a true statement about the data.
  A label that overclaims is a bug in the same way a wrong number is.

**You should be able to explain**

1. Why did the Today card show different numbers on the History page
   depending on which year you were looking at — and why is giving it its
   own state the fix, rather than fetching more years?
2. Why can't the app tell you what percentage of a *past* day's due items you
   actually did, when it can tell you that for today?
3. The Dashboard says "4 left today" and History says "1 of 5 handled". Why
   are both correct at the same time?

**Follow-up the same day — the two design questions**

Both of the open items from this session's review were decided and built:

- **The wordmark now says "Spaced Repetition Tracker."** "Almanac" was the
  name of the *palette* — indigo night sky, moon-phase history — and it
  never described the product to anyone landing on the page. Only the
  visible strings changed. The Tailwind color tokens are still `almanac-*`,
  deliberately: those names are internal, nobody sees them, and renaming
  them would touch every `className` in every component for no user-visible
  benefit. **A visual direction's codename and a product's name are allowed
  to be different things.**
- **The login card is vertically centred and now introduces itself.** The
  card used to be pinned near the top with `pt-10` on an otherwise empty
  page, which is what read as "floating" — the fix is centring within the
  viewport (`min-h-[70vh]` + `items-center`), plus a heading and a one-line
  description of the 2-7-30 idea inside the card. Checked at desktop and at
  375px; the heading wraps to two lines on mobile and the layout holds.

## 2026-08-01 (same day, later) — Naming, and auditing the four Dashboard stats

**What was built**

- **The app is now called `2-7-30`.** After the earlier rename to the
  descriptive "Spaced Repetition Tracker", we went one step further: the
  schedule *is* the product, so the schedule is the name. It's unique in a
  way no English word is, it's already the repo slug, and it explains itself
  the moment anyone asks. Candidates researched and rejected: *Lunation* (taken
  several times over by period-tracking and astrology apps), *Commonplace*
  (good fit — a commonplace book is literally a notebook of what you learned —
  but obscure), *Reprise*/*Revisit*. **The whole moon-themed branch was ruled
  out on principle:** we had just renamed *away* from a palette-derived name,
  so picking Crescent or Moondial would have reintroduced the same mismatch.
  Visible strings only; the `almanac-*` color tokens keep their name, and the
  repo/Vercel slugs were deliberately left alone (changing them changes the
  deploy URLs, which are written into `developer-handover.md`).
- **A typography fix the rename forced:** the display serif uses *old-style
  figures*, where `0` is drawn small and sits below the baseline. Fine in
  prose, but the wordmark is digits now and "2-7-30" was reading as "2-7-3o".
  Adding `lining-nums` makes all digits full height.
- **An audit of the four numbers on the Dashboard stat row**, prompted by you
  saying they felt "fishy". They were.

**Key decisions and why**

- **The arithmetic was right; two of the labels were wrong.** Checked every
  number directly against the database with SQL rather than trusting the code:
  127 reviewed + 33 skipped in 2026 = 79%, this week 6, last week 12, streak
  14. All correct. The bugs were in what the words *claimed* those numbers
  meant.
- **"79% completion this year" → "79% reviewed rather than skipped this
  year".** The number is `reviewed / (reviewed + skipped)`. It never looks at
  what was *due*. Review 3 items all year, skip nothing, ignore 500 others,
  and it proudly reports 100% completion. Exactly the same defect as the
  history legend's old "All reviewed" — a label asserting more than the data
  can support. A tooltip now spells out the limitation.
- **The weekly recap compared a partial week against a complete one.** "6 this
  week, down from 12 last week" measured Mon–Sat against a full Mon–Sun, so
  the verb was close to meaningless: a partial week almost always loses, and on
  a Monday morning it was guaranteed to say "down from". Now both sides measure
  Monday-through-the-current-weekday, and the copy says "by this point last
  week" to make the like-for-like explicit. Against the same data the honest
  comparison is 6 vs **11**, not 6 vs 12.
- **Streak and completion deliberately disagree about skips** — the streak
  counts a skip as showing up, the review/skip ratio counts it on the negative
  side. That's intentional and already documented in `items.service.js`: the
  streak asks "did you turn up?", the ratio asks "did you get through it?".
  Two different honest questions, which is why they don't have to match.

**Problems hit and how they were solved**

- **The week logic had no test, and one screenshot only proves one weekday.**
  The change was date-window arithmetic — exactly the kind that breaks silently
  at boundaries — and Saturday is the easiest case. `computeWeeklyRecap` was
  therefore moved out of `Dashboard.jsx` into its own `weeklyRecap.js`, purely
  so a test could import it without dragging in React and the API client, and
  `tests/weeklyRecap.test.js` now pins the Monday, Sunday and mid-week cases.
- **The test was checked by deliberately breaking the code.** Reverting the
  fix made exactly 2 assertions fail; restoring it made all 30 pass. A test
  that has never been seen to fail isn't yet known to test anything.

**New concepts introduced**

- **Old-style vs. lining figures**: many serif typefaces draw numerals at
  varying heights, like lowercase letters, so they sit comfortably inside
  running prose. `font-variant-numeric: lining-nums` forces them all to
  cap height instead — which is what you want any time digits are a *label*
  rather than part of a sentence.
- **Mutation testing, in miniature**: break the code on purpose and confirm
  the test notices. It's the only way to distinguish a test that guards the
  logic from one that merely runs it.
- **A denominator you don't have is a denominator you can't report.** Every
  "% complete" needs to answer "percent of *what*". When the app never
  recorded what was due on a past day, no honest percentage exists, and the
  fix is to describe what you *did* measure.

**You should be able to explain**

1. Why is `reviewed / (reviewed + skipped)` not a completion rate, and what
   would the app have to store for a real one to be possible?
2. Why did the old weekly recap say "down from" almost every day, and what
   makes the new comparison fair?
3. Why does a skipped item keep your streak alive but count against the
   reviewed/skipped ratio — and why is that not a contradiction?

## 2026-08-02 — Closing the January gap, and catching the docs up with the app

**What was built**

Three cleanup items, chosen after auditing what was actually left. No new
features — the app had drifted *ahead of its own documentation*, which is
the kind of gap an outside reader notices first.

1. **The weekly recap's January year-boundary gap is now fixed**, not merely
   documented. `refreshStats()` fetches the previous year's history as well
   on Jan 1–13, and merges it before computing the recap.
2. **`developer-handover.md` caught up**: a new §10c recording yesterday's
   rename and stat-row audit in full, a naming note at the top of §10 (the
   *palette* is Almanac, the *product* is 2-7-30 — the doc uses both words
   and never explained the difference), and a correction to §12a's deploy
   checklist, which still told a future reader to expect the old
   `"100% completion this year"` string on screen.
3. **`user-manual.md` rewritten.** It was 105 lines describing an app that no
   longer existed: no History page, no streak, no daily goal, no weekly
   recap, no light/dark toggle, and the wrong name at the top.

**Key decisions and why**

- **Jan 1–13, not "the first week of January".** The recap looks back at most
  13 days — on a Sunday that's 6 days to this week's Monday plus 7 more — so
  Jan 13 is the last date whose window can still touch the previous year. The
  bound is derived from the window, not guessed, and the comment says how.
- **Only fetch the extra year on the days it can matter.** A second request
  on ~13 days a year is invisible; a second request on all 365 is waste. The
  original decision (accept the gap, don't fetch) was reasonable when this
  was a fresh feature; it stopped being reasonable once the whole session had
  been about numbers quietly reporting the wrong thing. A New Year that
  silently reads as "your effort collapsed" is exactly that failure again.
- **Checked the streak for the same bug — it doesn't have it.**
  `getCurrentStreak` queries all-time on purpose, unlike `getReviewHistory`'s
  one-year scope, so a streak spanning Dec 31 → Jan 1 survives. Worth the
  30 seconds it took to confirm rather than assume, since a year-scoped
  streak would have reset *everyone* to 1 every New Year's Day.
- **The manual documents the limitations, not just the buttons.** It now
  explains why "left today" and History's "of 5 handled" legitimately differ,
  why the streak and the reviewed-rather-than-skipped share can disagree, and
  why a full moon does not mean "got everything done". Those were the exact
  three things that looked broken to a first-time user, so answering them in
  writing is cheaper than answering them again.
- **Behaviour was verified before being written down.** `applySkip` was read
  directly to confirm a skip pushes the due date by exactly one day and never
  changes the review stage, and the password rules were read out of
  `auth.schemas.js`, rather than trusting the old manual's wording. A manual
  that confidently describes the wrong behaviour is worse than no manual.

**Problems hit and how they were solved**

- **The new January path can't be exercised today**, since it only runs in
  January. Rather than leave it entirely unchecked, the two year-boundary
  cases were pinned as unit tests: one proving the recap reads December
  correctly *when the caller supplies those days*, and one documenting the
  exact failure mode — same date, same activity, December withheld, and the
  numbers silently drop to near zero. The second test is really a description
  of the bug, kept executable so nobody re-accepts it by accident.

**New concepts introduced**

- **Deriving a bound instead of picking one**: "Jan 1–13" isn't a guess or a
  safety margin, it's the largest date whose 13-day lookback still crosses the
  year. When a constant encodes a rule, write down the arithmetic that
  produced it — otherwise the next person tightens or loosens it blindly.
- **Documentation drift**: code changes in one commit, prose describing it
  doesn't, and the two silently disagree. It's invisible from inside the
  codebase and glaring to anyone arriving new — the same shape of problem as
  a mislabelled statistic, one layer out.

**You should be able to explain**

1. Why is the extra history fetch limited to January 1–13, and where does 13
   come from?
2. Why doesn't the streak need the same fix the weekly recap needed?
3. Why does the user manual spend as much space on what the numbers *can't*
   tell you as on what they can?

## 2026-08-02 (same day, later) — Deciding what's left: two features in, three out

**What was built**

Nothing — this was a scoping conversation, recorded here because the
*reasons* for saying no are the part worth keeping.

**Key decisions and why**

- **Change password: yes, and first.** The user is already logged in, so it's
  `bcrypt.compare` the current password, re-hash the new one, update the row.
  Crucially it's the only candidate that **works in production as it stands**,
  because it needs no email and no Redis.
- **Refresh tokens: yes, second, as an explicitly-labelled bonus.** The graded
  spec says *no refresh tokens*; that stays the submitted design, and the
  bonus demonstrates the alternative rather than quietly contradicting the
  spec.
- **Password recovery: no.** It sounds adjacent to change-password but is a
  different feature: the user is *locked out*, so it needs working email
  delivery (which prod doesn't have), a single-use expiring token, a reset
  page, rate limiting, and uniform responses that don't leak which addresses
  have accounts. Several times the work, undemoable live.
- **File upload and tags: no.** Near-zero learning value on this schema.
- **A correction worth recording, because it was mine.** Earlier in the
  session the backlog was described in a way that implied the mailer and
  Redis were still to be built. They aren't — `src/lib/emailQueue.js`,
  `worker.js` and `src/lib/redis.js` have existed for a while. What's true is
  narrower and more useful: **they don't run in production.**
  `.env.production` has no `REDIS_URL`, so both `redis` and `emailQueue`
  evaluate to `null` *by design*; welcome emails are silently skipped, the
  due-items cache fallback is inert, and `/health` reports
  `redis: "not-configured"`. And `worker.js` is a long-running process, which
  Vercel's serverless platform cannot host at all. The gap is hosting, not
  code — but it's a hard constraint on anything built next.

**Problems hit and how they were solved**

- **The interesting question about refresh tokens turned out not to be the
  backend.** The pieces (short access token, rotation, reuse detection,
  revocation) are well-trodden. The trap is on the *client*: a 401 interceptor
  that refreshes and retries must be **single-flight**. If five requests 401
  at once and each starts its own refresh, rotation invalidates your own
  session and logs the user out — a bug that only appears under concurrency,
  which is exactly when it's hardest to see.
- **Checked whether refresh tokens actually solve a problem here. Mostly not.**
  Suspend already ends a session instantly, because the auth middleware
  re-checks user status against the database on every request. So revocation
  is already handled the simple way. That's a fine reason to build refresh
  tokens *as a learning exercise* — it is not a reason to claim they fix
  something, and the handover now says so in those words.

**New concepts introduced**

- **Refresh token rotation and reuse detection**: each refresh swaps the old
  token for a new one, and a token presented *after* it was rotated means it
  leaked — so the correct response is to invalidate the whole family of
  tokens descended from that login, not just the one presented.
- **Single-flight** (also called request coalescing): when N callers all need
  the same expensive result, one call is made and the other N-1 wait on that
  same promise. Standard fix for the refresh stampede.
- **"Works locally" vs "works in production" is a design constraint, not a
  deployment detail.** Redis exists in this codebase and is genuinely used —
  and is still unavailable where the app actually runs. That's why refresh
  tokens should be stored in Postgres here, even though Redis is the textbook
  answer.

**You should be able to explain**

1. Why is change password a small feature and password recovery a large one,
   when they both end with "the user has a new password"?
2. What is the single-flight problem with refresh tokens, and why does token
   *rotation* make it worse rather than better?
3. Why should this app store refresh tokens in Postgres rather than Redis,
   even though Redis is already in the codebase?

## 2026-08-03 — Change password, built (part 1 of §12b)

**What was built.** `POST /api/v1/auth/change-password`: a logged-in user
sends their current password plus a new one, the same password rules from
registration apply to the new one (min 8, one letter, one number), and the
response is a fresh token. Lives in the frontend as a new "Account" tab
next to Due today / All items / Admin on the Dashboard — the existing
tab-switcher pattern, no new route.

**The decision made first, before any code: does this end other sessions?**
With plain JWTs, a token is validity-by-signature only — the server doesn't
normally track which tokens exist, so there was nothing to revoke. Two
options were on the table: leave it (old tokens keep working up to 7 days),
or add just enough state to say yes. Went with **yes**, via one new column:
`User.tokenVersion` (Int, default 0). It's carried inside the JWT payload at
login, and `requireAuth` — which already re-fetches the user row on every
request to check `isSuspended` (see 2026-07-something's suspend work) — now
also compares `payload.tokenVersion` against the database value in that same
lookup. Changing the password increments the column; every other token
anyone is holding for this user fails that comparison on its very next
request. This is *not* the refresh-token feature — no rotation, no token
family, no new table. It's the smallest thing that answers "yes" using
machinery that was already half there.

**The bug this almost shipped with.** Bumping `tokenVersion` invalidates the
token that was used to make *this very request* too — so a naive
implementation would change the password successfully and then immediately
log the user out, which reads like the feature is broken. Fixed by having
`changePassword` sign and return a brand-new token in the same response, and
having the frontend hand that token to the exact same `handleLoggedIn` path
`AuthForm` uses after login (`localStorage.setItem` + `setToken` in
`App.jsx`). Verified in the browser: after changing password, the app stays
on the Account tab, no redirect to login, and a follow-up request (switching
to the Due today tab) succeeds — proving the new token actually works, not
just that the page didn't crash.

**The second thing checked before trusting the column: old tokens issued
before it existed.** Those carry no `tokenVersion` in their payload at all
(`undefined`), and after the migration every existing user row has
`tokenVersion: 0`. `requireAuth` treats a missing payload value as `0`
(`payload.tokenVersion ?? 0`) rather than comparing `undefined !== 0`, so a
token signed last week doesn't get silently logged out the moment this
deploys. This was caught by running the change locally, not by reasoning
about it — the first curl-based test of `/auth/me` failed with a bare
`(payload.tokenVersion ?? 0) !== user.tokenVersion` bug for an unrelated
reason (stale generated Prisma client after the migration — `npx prisma
generate` hadn't rerun), which is its own lesson below.

**Where it lives in the UI — the other decision made deliberately.** There's
no settings screen and the top bar (`AlmanacShell`) has no spare room. Rather
than force a new top-level route, change-password reuses the Dashboard's
existing `view` state (`'due' | 'all' | 'admin' | 'account'`) the same way
the Admin screen already does for admins — one more pill button, one more
branch in the same ternary. Smallest diff that fits the existing shape of
the app.

**Problems hit and how they were solved**

- **Prisma client goes stale on a schema change, silently.** Adding
  `tokenVersion` to `schema.prisma` and running the migration updates the
  *database*, but the already-running dev server's generated `@prisma/client`
  still doesn't know the column exists — so `user.tokenVersion` came back
  `undefined` at runtime, `undefined !== 0` was true, and *every* request
  (not just old-token ones) got rejected as invalid. Fixed by running `npx
  prisma generate` and restarting the server. `postinstall` only runs
  `prisma generate` on `npm install`, not on every schema edit — worth
  remembering for the refresh-token table next.
- **A confirm-password field was added on the frontend only**, comparing
  `newPassword !== confirmPassword` before the request is even sent. The
  backend has no opinion on confirmation — it only ever sees `newPassword`.
  This exists purely to catch a typo before it becomes the account's new,
  unknown password; verified by deliberately mismatching the two fields in
  the browser and confirming the request never left the page.
- **Production migration is a manual step, same as the seed script.** This
  project's Vercel build only runs `prisma generate`, not `prisma migrate
  deploy` — the last production push was schema-free and didn't need this.
  Deploying this feature means running the migration against production
  Postgres *before* the new code goes live (a `findUnique` selecting a column
  that doesn't exist yet would 500 every request). Not done yet — this
  session stayed local; see "Not done yet" below.

**New concepts introduced**

- **Token versioning**: a cheap way to make normally-stateless JWTs
  revocable without a token database. One integer on the user row, embedded
  in the token at sign time, checked against the current value on every
  request. It can only invalidate *all* of a user's tokens at once (bump the
  number), not one specific token — that finer-grained control is what the
  refresh-token feature's rotation/reuse-detection will add later.
- **Why this doesn't overlap with refresh tokens as much as it looked like it
  would.** The open question in the last session was "sequence change-password
  so the answer is yes, and here's how" — the assumption was that answer
  would arrive *via* refresh tokens. It didn't need to: `tokenVersion` answers
  it independently, using a fact that was already true (`requireAuth` already
  hits the database every request). Refresh tokens are still coming, for
  their own reasons (short-lived access tokens, rotation, reuse detection) —
  they just aren't the mechanism this particular yes/no depended on.

**Not done yet**

- **Not deployed.** Everything above is verified locally only (curl against
  the dev server, and the Account tab exercised in the browser preview). The
  migration has not been run against production Postgres, and `main` has not
  been pushed — both need the user's go-ahead first, per this project's own
  rule about production database changes.
- **Refresh tokens (§12b part 2)** are still not started. They remain a
  separate, explicitly-labelled bonus.

**You should be able to explain**

1. Why does `requireAuth` check `payload.tokenVersion ?? 0` instead of just
   `payload.tokenVersion`, and what would break for existing logged-in users
   if it didn't?
2. `changePassword` bumps `tokenVersion` and then immediately signs a new
   token in the same response — why would skipping that second step turn a
   successful password change into a bug report?
3. `tokenVersion` can log out *all* of a user's other sessions at once, but
   not just one specific device. What would it take to revoke a single
   session instead, and which upcoming feature is that?

## 2026-08-03 (same day, later) — Refresh tokens, built (part 2 of §12b, bonus)

**What this is and isn't.** This is an explicitly-labelled bonus branch, not
the graded design — `submission-requirements.md` says "7-day token, no
refresh tokens," and that stays the submitted decision. This session builds
the alternative on top of it anyway, as a learning exercise, and the docs
(this entry, `developer-handover.md` §12b) say so rather than quietly
changing what's graded.

**What was built.** The single 15-minute-shorter access token
(`src/lib/jwt.js`'s `EXPIRES_IN`, was 7d, now 15m) is now paired with a
7-day refresh token stored in Postgres — a new `RefreshToken` table
(migration `20260803055407_add_refresh_tokens`), not Redis, because
production has none (`developer-handover.md` §6/§12). `POST /auth/login`
now returns `{ accessToken, refreshToken }` instead of `{ token }`. New
routes: `POST /auth/refresh` (rotates: the presented token is revoked as
part of issuing the next pair) and `POST /auth/logout` (revokes it early,
on purpose). `changePassword` and admin suspend both got a matching
`revokeAllRefreshTokensForUser` call.

**Rotation + reuse detection, the core mechanic.** Every refresh token is
one row (`familyId`, a SHA-256 `tokenHash`, `expiresAt`, `revokedAt`). Using
a token doesn't delete the row — it sets `revokedAt` and creates a new row
with the *same* `familyId`. That's what makes reuse detectable: a legitimate
client only ever has the newest token in a family, so the **only** way an
already-`revokedAt` token gets presented again is if someone else has a
copy — a leak. When that happens, `refresh()` doesn't just reject the one
token, it revokes every unrevoked row sharing that `familyId`, killing the
whole chain back to the original login. Verified live with curl: log in,
refresh once (get token B), present the original token A again — rejected,
*and* token B (which had done nothing wrong) is now also dead, because it's
in the same family. That's the intended blast radius, not a bug: token A
being reused means the family is compromised, not that token A specifically
is compromised.

**The gap the handover's own scope list had.** §12b's revocation-paths list
said "logout, and suspend" — it didn't mention change-password. Worked
through why that's a real hole, not a nitpick: `refresh()` mints a new
access token from the **current** `user.tokenVersion` read fresh from the
database, not from anything in the old token's payload. So if an attacker
had a stolen-but-unused refresh token, and the real user changed their
password specifically because they suspected exactly that, the attacker's
next `/auth/refresh` call would still succeed and hand back a brand-new,
fully-valid access token — tokenVersion and all. `changePassword` bumping
`tokenVersion` protects *access* tokens the attacker already had; it does
nothing about a *refresh* token the attacker has, because refresh tokens
aren't JWTs and were never checked against tokenVersion at all. Fixed with
one `revokeAllRefreshTokensForUser` call added to `changePassword`, right
alongside the tokenVersion bump. The handover wasn't wrong when it was
written — refresh tokens didn't exist yet — but building them created a gap
its own older text didn't anticipate, which is exactly the kind of thing
this project's rules say to raise rather than silently work around.

**The frontend trap, and how it was actually proven, not just built.** A 401
means the access token needs refreshing — `api.js`'s `request()` now catches
that, calls a `refreshAccessToken()` helper, and retries the original call
once with the new token. The trap: if two requests 401 around the same
time and each starts its own `/auth/refresh` call, the *first* response
rotates the token and the *second* call presents the now-already-rotated
one — reuse detection (the feature working exactly as designed) kills the
whole session. Fixed with a single module-level `refreshPromise` in
`api.js`: the first 401 starts the real fetch and stores the promise;
anything else that 401s while it's in flight gets handed that same promise
instead of starting a second one. This wasn't just reasoned through and
trusted — it was caught happening for real in the browser. React's
StrictMode double-invokes effects in development, so the app's own
`getMe()` bootstrap call on mount fired twice; with a deliberately corrupted
access token in `localStorage`, the network log showed **two** concurrent
`GET /auth/me` calls both getting a 401, but only **one**
`POST /auth/refresh` — and the app stayed logged in. Without the shared
promise, that exact sequence is the bug the handover warned about, happening
from ordinary React behavior, not a contrived test.

**Problems hit and how they were solved**

- **`vi.mock()` doesn't reach a nested CJS `require()`.** The first attempt
  at a rotation/reuse test mocked `../src/lib/prisma.js` the normal Vitest
  way, expecting `auth.service.js`'s `require('../lib/prisma')` to pick up
  the mock. It didn't — the test kept hitting a *real* (misconfigured, no
  `DATABASE_URL` in the test env) Postgres connection and failing with a
  SASL auth error. Traced it with a minimal two-file repro: mocking works
  fine when the *test file itself* imports the mocked module, but breaks
  the moment an intermediate plain CommonJS file is the one doing the
  `require()` — this project's `"type": "commonjs"` setup doesn't route that
  nested `require()` through Vitest's mocked module graph. Fixed by not
  mocking the module at all: importing the *real* singleton client and using
  `vi.spyOn()` on its methods (`prisma.refreshToken.findUnique`, etc.)
  instead. That works regardless of the require/import mismatch, because
  it's just mutating properties on the one shared object instance every
  file's `require()` call already resolves to — no module interception
  needed.
- **The same test file's mocks bled into each other.** `vi.spyOn()` in a
  `beforeEach` without first restoring the previous test's spies keeps
  their old resolved values and — more subtly — their accumulated
  `mock.calls` history, so a `toHaveBeenCalled()` assertion in test 3 could
  see a call made back in test 1. Fixed with `vi.restoreAllMocks()` at the
  top of `beforeEach`, before re-spying.
- **Prisma client stale after the schema change, again.** Same lesson as
  last session's `tokenVersion` column: `npx prisma migrate dev` updates the
  database, but the running dev server's generated client doesn't know
  about the new `RefreshToken` model until `npx prisma generate` runs and
  the server restarts. Did both this time before testing, rather than
  finding out the hard way.

**New concepts introduced**

- **Refresh token rotation**: instead of one refresh token living
  unchanged for its whole lifetime, every use retires it and issues a
  replacement. This turns "is this token still valid?" into a question with
  a much smaller, more useful answer space: valid (the newest in its
  family), or *reused* (a specific, detectable red flag), rather than just
  valid/invalid.
- **Token families**: the reason rotation can *detect theft* and not just
  churn tokens for no reason. Every token descended from one login shares an
  id; punishing reuse means killing the whole family, not just the one
  token that got reused — because if one member of the family was copied,
  there's no way to know from the token alone whether the copy or the
  original showed up first.
- **Single-flight** (the frontend concept, not specific to auth): when
  multiple concurrent callers would otherwise each trigger the same
  expensive/stateful operation, share one in-flight promise instead of
  starting a second one. The general shape shows up anywhere an operation
  has a side effect that isn't safe to run twice concurrently — rotation is
  one example of "not safe to run twice," not the only kind.

**Not done yet**

- **Not deployed.** Verified locally only: curl for every backend path
  (login, refresh, rotation, reuse detection, expiry, suspend, logout,
  logout-is-idempotent), the browser for the frontend (login, a corrupted
  token silently recovering via a real concurrent-401 case, logout, and
  change-password's new token pair). The migration hasn't run against
  production Postgres, and neither this nor the change-password migration
  from the last session has been pushed — both should probably go up
  together, since production has been on the old single-token contract this
  whole time.
- **Lifetimes may change.** Started at 15 minutes access / 7 days refresh;
  the plan is to try 30 minutes / 30 days once this is confirmed working,
  rather than tune it up front.

**You should be able to explain**

1. Why does presenting an already-rotated refresh token kill its *whole
   family*, instead of just that one token?
2. `developer-handover.md`'s §12b listed "logout, and suspend" as the
   revocation paths to build. Why does change-password need one too, once
   refresh tokens exist, even though it didn't need anything from them
   before?
3. Two requests 401 at almost the same instant, and both start their own
   `/auth/refresh` call. Walk through exactly what goes wrong, step by step,
   ending in the user getting logged out.
