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
