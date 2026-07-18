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
