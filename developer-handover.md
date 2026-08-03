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

> **Naming, to avoid confusion while reading this section.** "Almanac" is the
> name of the **visual direction** — indigo night sky, gold accent, moon-phase
> history — and it survives in the `almanac-*` Tailwind tokens and in
> `AlmanacShell.jsx`. The **product** is called **2-7-30** (renamed
> 2026-08-01, see §10c): the schedule is the thing the app actually is, and
> the old wordmark described the palette rather than the product. The tokens
> were deliberately *not* renamed — they're internal, and touching every
> `className` in every component buys nothing a user can see.

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
the same day. `computeWeeklyRecap(days, today)` — a pure function, same shape
as the backend's `deriveReviewHistory` — derives it from the `history.days`
array `refreshStats()` already fetches, no new endpoint. Calendar week
(Mon–Sun), not a rolling 7-day window; renders as one more clause on the
existing plain-text stat line.

**Both of this section's original caveats were resolved on 2026-08-01
(§10c) — read that before trusting the example strings above.** The function
now lives in its own module, `frontend/src/weeklyRecap.js`, so
`tests/weeklyRecap.test.js` can import it without pulling in React; the two
weeks are compared over the *same* slice rather than partial-vs-complete;
and the January year-boundary gap is fixed in `refreshStats()` rather than
being accepted.

### 10c. First outside walkthrough — rename, and the stat-row audit (2026-08-01)

The app was clicked through end-to-end by someone who hadn't built it, for
the first time. Six observations came back; four were defects. All fixed,
verified in a browser against a locally seeded database, and deployed the
same day (commits `fe5636c`, `b1ec8e2`, `5b7f809`).

**Two rendering bugs.**

- The History page's "today" moon was **inverted**. `moonStyle()`'s fill
  table ran `[64, 44, 32, 18, 0]`, so index 0 — nothing handled — painted the
  entire 64px disc gold, visually identical to "everything done". Now
  `[0, 18, 32, 44]` with the full-disc case branching separately, so the moon
  *waxes*. The same defect was in the approved reference file
  `design/review-history-demo.html` (its base `.moon-today` rule carried
  `inset 64px` and `.p0` never overrode it) and was fixed there too —
  otherwise the next port reintroduces it. **Worth internalising:** an inset
  `box-shadow` with a positive x-offset fills the element from the *left*, so
  an offset equal to the width covers all of it.
- The **"Today" card changed its numbers with the year selector** — "1 of 5
  handled" on 2026, "0 of 4" on 2025. It looked today's date up inside the
  year-scoped `days` map, which on any past year simply doesn't contain
  today. Today now has its own state, populated only from the current-year
  load.

**Two labels that claimed more than the data supports.** This turned out to
be the theme of the session, and it's the thing to watch for in any new stat:

- Grid legend said **"All reviewed"** → **"Reviewed, no skips"**. A full moon
  only means every *logged action* that day was a review. Items never touched
  write no row at all, so they cannot be counted.
- Stat row said **"79% completion this year"** → **"79% reviewed rather than
  skipped this year"** (plus a `title` tooltip). The number is
  `reviewed / (reviewed + skipped)` and never looks at what was *due* —
  review 3 items all year, skip nothing, ignore 500 others, and it reported
  100% completion.
- Related: **"N due today" → "N left today"**, because the due list is the
  remainder after today's reviews, while History's "x of y handled" counts
  the whole day. Both numbers were right; they looked like a contradiction.

**Weekly recap, reworked.** It compared this week's Mon–today against last
week's *complete* Mon–Sun, so the up/down verb was close to meaningless — a
partial week almost always loses, guaranteed on a Monday morning. Both sides
now measure Monday-through-the-current-weekday and the copy says "by this
point last week". Against the `stats-test@example.com` fixture the honest
comparison is 6 vs **11**, not 6 vs 12. The January year-boundary gap this
section used to accept is also closed: `refreshStats()` fetches the previous
year as well on Jan 1–13, the only dates whose 13-day window can reach back
across New Year.

**Naming.** The product is now **2-7-30** — the schedule is what the app
actually is. *Almanac* named the palette and told a visitor nothing.
Researched and rejected: *Lunation* (taken by several period-tracking and
astrology apps), *Commonplace*, *Reprise*. The entire moon-themed branch was
ruled out on principle — renaming away from a palette-derived name and then
picking another one reintroduces the same mismatch. **Visible strings only**:
the `AlmanacShell.jsx` wordmark, the `AuthForm.jsx` heading, and
`frontend/index.html`'s `<title>`. The `almanac-*` tokens and the GitHub /
Vercel slugs (`solidify-with-2-7-30`) are unchanged — the slugs are load-
bearing in this document's URLs.

One typography consequence worth knowing: the display serif uses **old-style
figures**, which draw `0` small and below the baseline. Fine in prose, but the
wordmark is digits now and "2-7-30" rendered as "2-7-3o", so both the wordmark
and the login heading carry `lining-nums`.

**Testing.** `computeWeeklyRecap` had no test, and a screenshot only ever
proves one weekday. It moved into `frontend/src/weeklyRecap.js` purely so
`tests/weeklyRecap.test.js` could import it without React or the API client;
it now pins Monday, Sunday, mid-week and the year boundary. The tests were
checked by deliberately reverting the fix and confirming they fail.

**Not a bug, but know it before demoing:** `scripts/seed-test-data.js` seeds a
clean 8-day streak *including today*, so a freshly seeded account already has
one review logged and never shows the new-moon state. Reseed on the morning
of a demo — the whole fixture is relative to the day it runs.

## 11. Running it

See `README.md` — it has the actual commands (local run, tests, Docker,
deploy). Not duplicating them here since that file is the one kept
guaranteed current.

## 12. Known gaps / backlog (nothing here blocks the app working)

- ~~**Neon prod DB password was exposed in an AI chat session
  (2026-07-18).**~~ **Rotated 2026-07-31.** Reset via Neon's console
  (reached through Vercel's "Vercel-managed" Storage integration →
  "Connect" → "Reset password" on the `neondb_owner` role). The old
  password stopped working immediately; Vercel's env-var *value* may sync
  automatically through the integration, but the already-running
  deployment doesn't pick up a changed env var until redeployed — confirmed
  this the hard way (`/auth/login` 500'd right after the reset, a manual
  Vercel redeploy fixed it). Verified live: `demo@example.com` logs in
  successfully post-redeploy.
- ~~**Change password** and **refresh tokens** — both built and
  deployed 2026-08-03.~~ See §12b for the full scope, the design decisions
  taken, and the traps. No longer a gap.
- **Due-date email reminders** (a scheduler, distinct from the welcome email
  already built) — explicitly backlogged in the original spec, not started.
- **Password recovery** — **deliberately declined in favour of change
  password** (2026-08-02). It's for a user who is *locked out*, so it needs
  working email delivery, a single-use expiring token, a reset page, rate
  limiting, and uniform responses that don't reveal which addresses have
  accounts. Several times the work of change-password, and undemoable in
  prod, where outbound email doesn't run.
- **File upload and tags** — explicitly backlogged in the original spec and
  **declined 2026-08-02**: near-zero learning value on this schema.
- **Statistics** — no longer a gap. Four bonus stats shipped 2026-07-30
  (`b7479c5`), and the whole stat row was audited and corrected 2026-08-01
  (§10c).
- **Worker + Redis don't run in production** — see §6; purely a hosting gap,
  not a code gap, but it constrains what a new feature can rely on. To be
  precise about what "doesn't run" means: `.env.production` has no
  `REDIS_URL`, so `src/lib/redis.js` and `src/lib/emailQueue.js` both
  evaluate to `null` by design. In prod, welcome emails are silently skipped,
  the due-items cache-on-failure fallback is inert, and `/health` reports
  `redis: "not-configured"`. Separately, `worker.js` is a long-running
  process, which Vercel's serverless platform cannot host at all — running it
  needs a different host (Railway/Render/Fly) plus a managed Redis (Upstash).
  **Anything new that must work in production has to work without Redis.**

### 12a. Deployment — pushed and verified live 2026-07-31

Decision (2026-07-30): finish the Almanac revamp first, then push, deploy and
seed production in one pass, so the whole app arrives aligned. Rationale: the
frontend and API are separate Vercel projects fed by the same `main`, so a
half-push puts a new frontend against an old API — and because the Dashboard
swallows stat-fetch errors (`.catch(() => {})`), that combination fails
*silently*: the stats row simply doesn't render, with no error anywhere.

**Done 2026-07-31** — steps 1–4 below, in order, once the weekly recap
(the last §10b item) landed:

1. **Pushed `main`** (`52d42ed` → `41fe4b7`, 24 commits). Both Vercel
   projects auto-redeployed from the same push.
2. **Nothing else needed configuring** — the stats/recap work is
   schema-free (`Review.date`/`Review.result` already existed), so no
   `prisma migrate deploy`, no new Vercel env var, no CORS change.
3. **Verified live, in order:** `/api/v1/health` → 200
   (`{"status":"ok","redis":"not-configured"}`, expected per §6 — no Redis
   in prod) → `/api/v1/items/review-history?year=2026` with `demo@example.com`'s
   real token → returns `days` → same URL **with** `&date=2026-07-31` →
   also returns `currentStreak` → logged into the live frontend
   (`https://solidify-with-2-7-30-7dc4.vercel.app`) as `demo@example.com` →
   Dashboard renders in the Almanac look (segmented Login/Register toggle
   confirmed it's the new build, not a stale cache) and shows "0 due today
   · 100% completion this year" with no console errors. **Both of those
   strings were changed on 2026-08-01 (§10c) — a repeat of this check should
   expect "0 left today · 100% reviewed rather than skipped this year".**
   Streak and the new
   weekly recap clause both correctly stayed hidden — `demo@example.com`'s
   seed data (from `prisma/seed.js`) has no activity in the current streak
   window or this/last calendar week, so both null-guards did their job
   rather than rendering a wrong number or crashing.
4. **`.gitignore` was already widened to `.env*`** (done 2026-07-30, commit
   `d2f27de`) — nothing left to do here; this doc previously listed it as a
   pending pre-deploy step, which was stale.

5. **Seeded 2026-07-31** — `stats-test@example.com` now has 164 review rows
   (131 reviewed, 33 skipped) live on prod. Verified via the API:
   `currentStreak: 14` (matches the script's own predicted value exactly),
   80 active days in `days`, 1 item due. Run by the user in their own
   terminal (not the assistant), per [[prod_demo_data_goal]]/the project's
   own convention — the seed script needs the real, un-redactable Neon
   connection string, which should never pass through an AI-assisted
   channel.

   **Real gotcha hit doing this:** `vercel env pull` cannot retrieve
   `DATABASE_URL_UNPOOLED`'s actual value — Neon's Vercel integration marks
   DB credential variables as Vercel **"Sensitive Environment Variables"**,
   which by design can never be read back through *any* channel (dashboard
   or CLI) once saved, only used internally at runtime. `vercel env pull`
   returns a fixed placeholder instead. The real value only lives in Neon's
   own console ("Connect" modal → toggle pooling off → "Copy snippet"),
   pasted by hand into a local `.env.production` (never through chat).
   `DATABASE_URL` (pooled) may or may not be similarly restricted — wasn't
   tested since the direct string is what the seed script needs anyway.
6. **Reseed on demo day.** Everything the fixture builds is relative to the
   day it runs: the streak ends on seed day and the due items are dated to
   it. Measured decay: streak 14 on seed day, 14 the day after, **0** by
   day three. (Also worth a fresh `DEMO_PASSWORD` if reseeding — the
   2026-07-31 run used a placeholder-looking password by accident.)

Known demo gotcha, no fix planned: the daily goal lives in `localStorage`,
which is per-origin. A goal set on the production URL won't exist on a Vercel
preview URL or on a phone — set it live during the demo rather than
pre-setting it.

### 12b. Change password + refresh tokens (decided 2026-08-02)

**Change password: built 2026-08-03.** `POST /auth/change-password`
(`src/routes/auth.routes.js`), validated by `changePasswordSchema`
(`src/dto/auth.schemas.js`), implemented in `authService.changePassword`
(`src/services/auth.service.js`). Both open questions below were decided
and built, not left open:

- **Ends other sessions: yes**, via a new `User.tokenVersion` column
  (migration `20260802180837_add_token_version`) embedded in the JWT payload
  and checked in `requireAuth` (`src/middleware/auth.js`) alongside the
  existing `isSuspended` check — no refresh-token machinery needed for this.
  `changePassword` returns a fresh token in the same response so the request
  that changed the password doesn't itself get logged out.
- **UI location:** a new "Account" tab on the Dashboard, next to
  Due today / All items / Admin (`AccountPanel.jsx`, wired into
  `Dashboard.jsx`'s existing `view` state) — reused the same pattern as the
  Admin tab rather than a new route.

**Deployed and verified live, 2026-08-03.** `main` pushed (`5b7f809` →
`50ea1af`), both Vercel projects auto-redeployed, and the migration ran
against production Postgres by hand (`prisma migrate deploy` with the real
Neon unpooled connection string, run by the user in their own terminal —
never through chat). It picked up three pending migrations, not two:
`20260725110336_add_review_index` had apparently never been applied either,
alongside `add_token_version` and `add_refresh_tokens`. Verified against the
live backend afterward: `/health` → ok, `/auth/login` (`demo@example.com`)
→ `{ accessToken, refreshToken }`, `/auth/me` with the fresh access token →
200, `/auth/refresh` with the fresh refresh token → rotates correctly, then
`/auth/logout` cleaned up the test session. Change password's migration
(`add_token_version`) rode along in the same `migrate deploy` run, so both
§12b features are now live together, as planned.

**Refresh tokens: built and deployed 2026-08-03.** All five pieces are done:
the access token is 15m (`src/lib/jwt.js`), the refresh token lives in a
Postgres `RefreshToken` table (migration `20260803055407_add_refresh_tokens`),
`POST /auth/refresh` rotates on use, reuse of an already-rotated token kills
the whole family, and logout/suspend/change-password all revoke. The
frontend's single-flight 401 interceptor (`frontend/src/api.js`) is built
and was verified against a *real* concurrent-401 case (React StrictMode's
double-mounted `/auth/me` effect), not just a contrived one. Full build log,
including the change-password revocation gap this surfaced (see below) and
a `vi.mock`-doesn't-reach-nested-`require()` testing gotcha, is in
`implementation-journey.md`'s 2026-08-03 (later) entry.

**One gap this surfaced in the plan above: change-password needed adding
as a fourth revocation path.** The scope list originally said "logout, and
suspend" — it didn't say change-password, because when it was written
change-password didn't exist yet and had nothing to revoke. Once refresh
tokens exist, that becomes a real hole: `refresh()` mints a new access
token from whatever `tokenVersion` currently *is*, not from the old token's
payload, so a stolen-but-unused refresh token would survive a password
change and keep minting valid, current access tokens. Fixed by having
`changePassword` also call `revokeAllRefreshTokensForUser`. Not a
retrofit of tokenVersion-checking into refresh-token logic (the "don't
connect them" note above still holds for that) — just closing a hole the
feature's own existence opened.

Both were chosen deliberately over the rest of the backlog. Do them in this
order — change password is small, real, and demoable in production today;
refresh tokens are the bigger learning exercise and the one with traps.

**Constraint that shapes both:** production has no Redis (see §12). Anything
that must work on the live deployment has to work with Postgres alone.

#### Change password (do first)

Small and self-contained: the user is already logged in and supplies their
current password plus a new one. `bcrypt.compare` the current, re-hash the
new, update the row. The existing password rules (`src/dto/auth.schemas.js`:
min 8, at least one letter, at least one number) apply unchanged.

Open questions worth deciding rather than assuming:
- Does changing a password end other sessions? With plain JWTs today it
  *can't*, unless the token check starts consulting something per request.
  This overlaps with refresh tokens — worth sequencing so the answer is
  "yes, and here's how" rather than a silent no.
- Where does it live in the UI? There is no settings screen; the top bar has
  no room. This is a real design decision, not an implementation detail.

#### Refresh tokens (do second, as an explicitly-labelled bonus)

**The spec conflict is deliberate and must stay visible.** The graded
`submission-requirements.md` says 7-day token, *no refresh tokens*. That
decision stands as the submitted design. Refresh tokens are a bonus branch
demonstrating the alternative, and the docs should say so plainly rather than
quietly contradicting the spec.

The pieces:
1. Split the current 7-day token into a short access token (~15 min) plus a
   long-lived refresh token.
2. **Storage — the real decision.** Redis is the natural fit and is already
   wired locally, but it is `null` in production. **A Postgres table is the
   pragmatic pick** if this is meant to work on the live deployment.
3. `POST /auth/refresh`, with **rotation**: the presented refresh token is
   invalidated as part of issuing the new pair.
4. **Reuse detection**: a token that was already rotated turning up again
   means it leaked — invalidate the whole family, not just that token.
5. Revocation paths: logout, and suspend.

**The trap that matters most is on the frontend.** A 401 interceptor that
refreshes and retries needs **single-flight**: if several requests 401 at the
same time and each fires its own refresh, rotation invalidates your own
session and logs the user out. One in-flight refresh promise, shared by every
waiting request. This detail is most of the actual difficulty.

**Second trap:** a refresh token you cannot revoke is just a longer-lived
access token — strictly *worse* than what exists today. Half-built is worse
than not built here.

**Worth knowing before starting:** suspend already invalidates sessions
instantly, because the auth path checks user status per request. So
revocation is, in practice, already solved the simple way. Refresh tokens
partly re-solve a problem this app does not currently have. That is a fine
reason to build them as a learning exercise — it is not a good reason to
describe them as fixing something.
