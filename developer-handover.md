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
- `design/` — static HTML design references (open directly in a browser, no
  build step). Currently just `review-history-demo.html` — see §10.
- `CLAUDE.md` — instructions for the AI pair-programming workflow used to
  build this (course context: a beginner + an AI co-pilot). Not relevant to
  running the app, relevant if you're continuing that workflow.

## 10. Frontend redesign — Almanac (design locked 2026-07-25; history page built same day)

A full frontend visual + UX revamp was scoped and design-explored in a
dedicated session (see `implementation-journey.md`, 2026-07-25 entries, for
the full back-and-forth and build log). A static, self-contained reference
build of the approved design still lives at
**`design/review-history-demo.html`** — open it directly in a browser, no
build step, no server needed — but it's now a *reference*, not the only
implementation: the real page is built (§10a). Every screen in the redesign
is built (§10a, as of AdminPanel on 2026-07-31), and the one idea from §10b
worth keeping (the weekly recap) is also built as of 2026-07-31 — **the
whole Almanac redesign, §10a and §10b both, is now feature-complete.**

**Committed locally, not pushed to `origin/main` yet** — held back so
production gets one complete visual pass instead of a half-restyled app
(pushing to `main` auto-deploys both backend and frontend on Vercel, per
§2/§11). Now that the redesign itself has nothing left to build, deploying
it is purely a "when the user wants to" decision — §12a has the deploy-and-
seed order for whenever that is. Don't push until the user explicitly asks
for it, and don't re-offer after every commit in the meantime.

### 10a. Built: infra + the review-history page

Done, live-verified in a browser, backend tests passing (19/19):

- **Backend**: `GET /items/review-history?year=YYYY` (route + controller +
  `items.service.js`), grouping `Review` by date/result into a sparse
  `{ year, days: [{ date, reviewCount, skipCount, state }] }` response.
  `state` is `'full'` (reviewed, no skips that day) or `'half'` (any skip
  that day, alone or mixed with a review — a deliberate call: skip-only
  days read the same as mixed, not as their own 4th state or as "no
  activity"). Days with zero rows are simply absent from the array.
  `@@index([itemId, date])` added to `Review` (migration
  `20260725110336_add_review_index`). Grouping/state logic is a pure,
  unit-tested function (`deriveReviewHistory` in `items.service.js`,
  covered by `tests/reviewHistory.test.js`) separate from the DB call, same
  pattern `schedule.service.js` already used.
- **Frontend infra**: Tailwind CSS v4 (`@tailwindcss/vite`) and
  `react-router-dom` installed. `frontend/src/index.css` imports only
  Tailwind's `theme` + `utilities` layers (**not** `preflight` — see the
  gotcha below) and defines the Almanac palette as `@theme` CSS variables,
  dark by default with a `[data-mode="light"]` override + OS-preference
  fallback. `App.jsx` now has two routes: `/` (old Dashboard/AuthForm swap,
  logic untouched) and `/history` (new page). Dashboard's own internal
  due/all/admin tab state was deliberately left alone, not converted to
  nested routes.
- **The review-history page** (`frontend/src/ReviewHistoryPage.jsx`): the
  three-state month grid, a year switcher (`<year>`/`>`, capped at the
  current year), the live-filling today moon (5 discrete phases, same
  ratio thresholds as the reference file), and the light/dark toggle.
  Today's moon fraction is `handled / (dueCount + handled)`, where
  `dueCount` = `GET /items/due`'s current result (which includes overdue
  backlog, so the copy says "today's workload", not "due today") and
  `handled` = today's `reviewCount + skipCount` from the history endpoint —
  reconstructing "today's original total" without ever storing it, valid
  only because the scheduler already forbids early reviews/skips.
- **Locked UX rule for the whole redesign, not just this page: follow the
  device's OS light/dark preference by default; the in-page toggle is a
  manual override, not the primary control.** Already how the history page
  behaves (`mode` state starts `null` → CSS falls through to
  `@media (prefers-color-scheme)`; clicking the toggle sets an explicit
  `light`/`dark` that then wins). Any future screen in this redesign should
  follow the same default-to-OS, override-via-toggle pattern rather than
  defaulting to a fixed theme.

**Phase 2 (2026-07-31): Dashboard, AuthForm, ItemDetail, and AdminPanel are
now all built** — every screen in the redesign is in the Almanac look, so
§10 as a whole is fully built. Design-locked the same way as the history
page each time — HTML-mockup Artifacts comparing whole named directions
(Dashboard: 4, AuthForm: 3, ItemDetail: 3, AdminPanel: 4) were shown before
any component was touched, and the user picked one for each. §10b, formerly
"not yet built: AdminPanel," is repurposed below for the one thing still
genuinely open: the discussed-not-committed ideas.

- **Shared shell** (`frontend/src/AlmanacShell.jsx`): one persistent top bar
  (brand, nav links, the light/dark toggle, logout) now wraps *every*
  screen via `App.jsx`, replacing each page building its own header. Fixes
  a real gap the mockup process surfaced: opening an item used to hide the
  header entirely, with no way to log out or flip theme from inside it.
  The `mode` state itself moved from `ReviewHistoryPage` up to `App.jsx` so
  the toggle survives navigating between screens instead of resetting.
- **Direction picked, "Combined"**: the shared top bar above (which fixes
  the ItemDetail gap) wrapping a flatter per-page body — plain title + stat
  line, pill tabs / segmented controls, no boxed "today"-style panel around
  the stats. Bar from one candidate direction, body language from another;
  see the git log for the rejected alternatives (Unified Shell's boxed
  stats panel, a two-column "Command Center" rail layout, a no-shared-shell
  "Minimalist" option).
- **Dashboard** (`frontend/src/Dashboard.jsx`): fully re-skinned — pill
  due/all/admin tabs, flat header. All four bonus stats (due count,
  completion rate, streak + tooltip, goal row with `<progress>`) and every
  handler are byte-for-byte unchanged; only markup/classes moved.
- **AuthForm** (`frontend/src/AuthForm.jsx`): a bordered card with a
  Login/Register **segmented pill toggle** at the top, replacing the old
  plain-text "Need an account? Register" link. Same fields/validation/
  submit copy. `user-manual.md`'s account-creation step named that old link
  text literally and needed a matching update.
- **ItemDetail** (`frontend/src/ItemDetail.jsx`): read view moves into a
  panel card; review history becomes a small dot-and-line **timeline**
  (filled dot = reviewed, hollow = skipped) instead of plain rows. Delete
  now uses a new `--color-almanac-danger` token instead of reusing the gold
  accent — a destructive action shouldn't share a color with primary ones.
  Same `getItem`/`updateItem`/`deleteItem` logic, same native-`confirm()`
  delete.
- **`Pagination.jsx`** (shared by Dashboard's All Items view and
  AdminPanel): restyled once since both consumers benefit; its old
  `.pagination`/`.pagination button` App.css rules are dead and removed.
- **Mobile-responsive pass**: an explicit check at 375px/768px (not done
  for the history page originally — worth doing for AdminPanel too) found
  one real bug: the shared header's nav row had no `flex-wrap`, so "Due &
  reviews" broke mid-phrase on a phone instead of wrapping as a whole item.
  Fixed in `AlmanacShell.jsx`; desktop/tablet checked and unaffected.
- **AdminPanel** (`frontend/src/AdminPanel.jsx`): rows now group into
  Active/Suspended sections (a count in each label) instead of one flat
  list, each row with a small circular initial "monogram" badge — the
  display serif in a circle, echoing the brand mark rather than a generic
  avatar. Same `listUsers`/`suspendUser`/`unsuspendUser` logic and
  pagination, untouched; only markup/classes changed, same as the other
  three screens. Dropped the temporary `<div className="app">` wrapper in
  `Dashboard.jsx` (§10b used to flag this), which made every remaining rule
  in `App.css` dead — deleted the file and its `import './App.css'` in
  `App.jsx`. AdminPanel's own mobile pass (375px) found a second real bug
  the same way the header one was found: long emails (one unbreakable
  token, no spaces) overflowed into the Suspend/Unsuspend button instead of
  wrapping; `break-words` on the email text fixes it, desktop/tablet
  unaffected.

**Three gotchas a next session needs to know, all bitten at least once already:**

1. **`App.css` has bare element selectors** (`button {}`, `h1 {}`, `form {}`,
   etc.), not scoped to `.app`. Any new Tailwind-styled page reuses the same
   HTML elements, so without scoping, `App.css` bleeds into it (discovered
   as an orange `<button>` showing up on the unrelated new page). They're
   now scoped as `:where(.app) button`, etc. — **`:where()`, not a plain
   `.app` prefix** — because a plain `.app button` selector is *more
   specific* than the bare `button` it replaced, which silently outranked
   existing overrides elsewhere in the file (broke `.add-item-form`'s
   row layout). `:where()` scopes without adding specificity. If you add
   more global selectors to `App.css`, scope them the same way. **`App.css`
   itself was deleted 2026-07-31** (AdminPanel was its last consumer, so
   every rule in it went dead) — kept as a gotcha here anyway, because the
   unlayered-beats-layered mechanism it explains is exactly what makes
   gotcha 3's `@layer utilities` rule below behave the way it does.
2. **Skipping Tailwind's Preflight means no CSS reset on the new page at
   all.** Every native element (`<a>`, `<button>`, eventually `<input>`/
   `<select>` if the redesign reaches a form) keeps its raw browser
   default — link-blue/visited-purple text, gray button chrome — unless a
   class explicitly overrides it. Bitten twice already: a nav `<Link>` with
   only a `hover:` class (no base text color) rendered as native
   link-purple in dark mode; a year-switcher `<button>` with only a
   `hover:` class kept native button chrome (gray box). Any bare `<a>`/
   `<button>` with just a `hover:*` Tailwind class and nothing else is
   suspect — give it an explicit base color and, for buttons,
   `bg-transparent border-0 p-0`.
3. **Skipping Preflight also means form controls (`button`/`input`/`select`/
   `textarea`) don't inherit typography from an ancestor at all** — the
   browser's own UI font/size wins instead, unless a Tailwind class sets it
   directly on that element. Every pill button across Dashboard/AuthForm/
   ItemDetail was silently rendering in Arial at ~13px instead of Optima/
   Futura + `text-sm`, and the edit `<textarea>` defaulted to monospace —
   only caught by comparing `getComputedStyle` before/after in the browser,
   not by looking at the JSX. Fixed once, globally, in `index.css`:
   `button, input, select, textarea { font: inherit; color: inherit; }` —
   **but it must live inside `@layer utilities`**, the same layer Tailwind's
   own utilities load into. An unlayered version of that rule beats
   `text-sm`/`text-almanac-mute`/etc. *unconditionally*, regardless of
   specificity (unlayered CSS always wins over layered CSS — see gotcha
   about `:where(.app)` above, same underlying mechanism, opposite
   direction), silently undoing every button's explicit size/color rather
   than just filling the gap for unstyled ones. If you add another global
   fallback rule for Tailwind-styled markup, it needs the same
   `@layer utilities` wrapper.

### 10b. Ideas discussed, not committed (now: process leftovers only)

Every screen in the redesign is built now (§10a), and the weekly recap
below is also built (2026-07-31) — nothing left in this section is a build
queue, just the process's own leftovers and design-direction history.

**Direction — "Almanac":** deep indigo (`#1B1F3B`) background, gold accent
(`#E8C468`), Big Caslon/Didot serif for display type, Optima/Futura for body
(all with system-font fallbacks — no webfonts loaded). Full token set (both
modes) is real code now in `frontend/src/index.css`, including
`--color-almanac-danger` added during the ItemDetail pass for destructive
actions. Two other directions were explored and rejected before Almanac:
a "Lab Notebook" concept (dropped — its signature idea needed a
memory-retention curve the schema can't honestly support, see §"why" below)
and a "Trail" forest/orange concept (palette liked, but ultimately not
chosen over Almanac).

**Playful/gamification ideas discussed, not committed:** a live-filling
"today" indicator (built into the design above) and a weekly recap
comparing this week's vs. last week's review count were the two considered
worth keeping — both computed from existing data, no new state. Rank titles
and milestone toasts were discussed and explicitly set aside as reading like
"a game skin bolted onto a study tool" rather than something native to the
design — revisit only if asked for directly.

**Weekly recap: built 2026-07-31**, in its own dedicated session as decided
the same day. `computeWeeklyRecap(days, today)` in `Dashboard.jsx` — a pure
function, same shape as the backend's `deriveReviewHistory` — derives it
from the `history.days` array `refreshStats()` already fetches, no new
fetch or endpoint. Calendar week (Mon–Sun), not a rolling 7-day window;
renders as one more clause on the existing plain-text stat line, e.g. "5
handled this week (Jul 27–Jul 31), down from 11 last week". Known, accepted
limitation: `getReviewHistory` fetches one calendar year at a time, so in
years where Jan 1 isn't a Monday (6 years out of 7), the calendar week
containing New Year's straddles the year boundary — for the first few days
of January, part of "last week" (or "this week") can fall in the previous,
un-fetched year and silently read as 0 there. Not worth a second fetch for
~1 week/year; see `implementation-journey.md`'s 2026-07-31 weekly-recap
entry for the full reasoning and verification (checked against the
`stats-test@example.com` seed fixture, hand-computed against
`scripts/seed-test-data.js`'s own pattern).

## 11. Running it

See `README.md` — it has the actual commands (local run, tests, Docker,
deploy). Not duplicating them here since that file is the one kept
guaranteed current.

## 12. Known gaps / backlog (nothing here blocks the app working)

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

### 12a. Deployment backlog — deliberately deferred until the §10b revamp lands

Decision (2026-07-30): finish the Almanac revamp first, then push, deploy and
seed production in one pass, so the whole app arrives aligned. Rationale: the
frontend and API are separate Vercel projects fed by the same `main`, so a
half-push puts a new frontend against an old API — and because the Dashboard
swallows stat-fetch errors (`.catch(() => {})`), that combination fails
*silently*: the stats row simply doesn't render, with no error anywhere.

**Current prod state (measured 2026-07-30):** `origin/main` is 8 commits and
8 days behind local (`52d42ed`). The deployed API has **no
`GET /items/review-history`** — its Swagger spec documents only `/items/due`.
Every one of the four bonus stats features reads that endpoint, so none of
them can work on prod until this is pushed.

Do these in order, when the revamp is done:

1. **Push `main`.** Lifts the hold documented in `7a0838a`. One push refreshes
   both Vercel projects.
2. **Nothing else to configure.** The stats work is schema-free — `Review.date`
   and `Review.result` already existed — so no `prisma migrate deploy`, no new
   Vercel environment variable, no CORS change. A plain redeploy is enough.
3. **Verify in this order** on the deployed URLs: `/api/v1/health` →
   `/api/v1/items/review-history?year=<year>` with a real token returns
   `days` → the same URL **with** `&date=<today>` also returns `currentStreak`
   → then the Dashboard header shows the due count, completion rate and streak
   together.
4. **Widen `.gitignore` from `.env` to `.env*`** *before* step 5 creates a
   local prod env file. One line, and it's what stops a Neon connection
   string from being committed.
5. **Seed the demo account** (see `scripts/seed-test-data.js`'s own header for
   the commands). Two things that are easy to get wrong:
   - `vercel env pull` is the way to get prod values locally — don't hand-copy
     from the dashboard. Then override `DATABASE_URL` with Neon's **direct
     (unpooled)** string, the same one §3 of the README uses for migrations.
     Note the script reads `DATABASE_URL`, *not* `DATABASE_URL_UNPOOLED`.
   - `DEMO_PASSWORD` is local-only. Never add it to Vercel's environment
     variables — the app never reads it, only the seed script does.
6. **Reseed on demo day.** Everything the fixture builds is relative to the
   day it runs: the streak ends on seed day and the due items are dated to it.
   Measured decay: streak 14 on seed day, 14 the day after, **0** by day three.

Known demo gotcha, no fix planned: the daily goal lives in `localStorage`,
which is per-origin. A goal set on the production URL won't exist on a Vercel
preview URL or on a phone — set it live during the demo rather than
pre-setting it.
