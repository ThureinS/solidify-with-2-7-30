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

## Stack

Node.js + Express, PostgreSQL via Prisma, JWT auth (bcrypt password
hashing), Zod validation, Vitest for the scheduling-logic tests, Docker
Compose for local Postgres, GitHub Actions for CI.

## Running locally

```bash
cp .env.example .env          # then set JWT_SECRET to a random string, e.g.:
                               # node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
docker compose up -d          # starts local Postgres
npx prisma migrate deploy     # applies the committed migrations
npm run seed                  # creates demo@example.com / Demo1234 (USER)
                               # and admin@example.com / Admin1234 (ADMIN)
npm run dev                   # starts the server on :3000
npm test                      # runs the scheduling unit tests
```

API docs (Swagger UI, every endpoint with an example): `GET /api/v1/docs`.

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
