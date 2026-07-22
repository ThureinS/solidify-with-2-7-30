# Spaced Repetition Review Tracker
## Backend MVP — Requirements Summary

## Summary

This project is a backend system for personal spaced-repetition learning. A user saves things they have learned as text items, and the system tells them exactly which items to review each day using the 2-7-30 review method. The first review is due 2 calendar days after an item is added; after each completed review, the next one is scheduled 7 and then 30 days from the completion date. After the third review, the item is archived. Missed days lose nothing — overdue items simply stay in the queue.

The core loop: add an item → the system schedules it → each day the user requests "what is due today" → they review or skip each due item → after the 30-day review the item is archived.

## Main Features

**Learning items**
- Logged-in users can add items (text only, 1–10,000 characters)
- List own items with pagination and status filter (active / archived / all); lists show a text preview
- View one item in full with its complete review history
- Edit an item's text (schedule unchanged)
- Soft delete an item (hidden, not destroyed)
- Export all own data as JSON, with an option to include soft-deleted items

**Review scheduling (2-7-30)**
- Daily due queue: items whose next review date is on or before the client-provided date
- Review a due item → recorded in history → advances to the next stage (2 → 7 → 30 → archived)
- Skip a due item → recorded in history → due again the next day
- Items can only be reviewed when due; early attempts and duplicate submissions are rejected (this single rule also provides double-click protection)
- All dates are plain calendar dates; "today" always comes from the client, never the server clock (timezone safety)

**Notifications of state:** review status is fully visible through the API (item stage, next review date, history); no push/email notifications in MVP.

**User roles**
- Guest — can register and log in only
- User — full access to their own items, reviews, and export
- Admin — list all users, suspend and unsuspend users (suspended users cannot log in)

## Main statuses (per item)

- active (stage 0: awaiting 2-day review, stage 1: awaiting 7-day, stage 2: awaiting 30-day)
- archived (all three reviews completed)
- deleted (soft-deleted, hidden everywhere, recoverable in database)

## Main API Routes

```
POST   /api/v1/auth/register
POST   /api/v1/auth/login
GET    /api/v1/health

POST   /api/v1/items
GET    /api/v1/items?status=&page=&limit=
GET    /api/v1/items/due?date=
GET    /api/v1/items/:id
PATCH  /api/v1/items/:id
DELETE /api/v1/items/:id
POST   /api/v1/items/:id/review
POST   /api/v1/items/:id/skip

GET    /api/v1/export?includeDeleted=

GET    /api/v1/admin/users
POST   /api/v1/admin/users/:id/suspend
POST   /api/v1/admin/users/:id/unsuspend
```

## Technical Requirements

Desired stack:

| | |
|---|---|
| Language | Node.js (JavaScript) |
| Framework | Express |
| Database | PostgreSQL (Neon in production) |
| ORM | Prisma (with Prisma Migrate) |
| Authentication | JWT (7-day access token), bcrypt password hashing |
| Request Validation | Zod (input DTOs) + output mappers (no raw DB rows in responses) |
| API Docs | Swagger (hand-written OpenAPI spec, served at /api/v1/docs) |
| Testing | Vitest + Supertest (scheduling logic unit tests) |
| Local Dev | Docker Compose (PostgreSQL) |
| CI/CD | GitHub Actions (tests run on every push) |
| Deployment | Vercel (Express as serverless function) |

Main models:

- User (id, email unique, passwordHash, role USER/ADMIN, isSuspended, createdAt)
- Item (id, userId, text, dateAdded, nextReviewDate, stage, isComplete, deletedAt)
- Review (id, itemId, date, result REVIEWED/SKIPPED)

The backend must use hashed passwords (bcrypt), JWT authentication, role-based admin access, request validation on every endpoint, rate limiting on auth routes, pagination, database migrations, environment variables with a committed .env.example, Swagger documentation, Docker setup for local development, and CI configuration.

The code follows: **Routes → Controllers → Services → Prisma (Repository) → Database**, with scheduling rules implemented as pure, unit-tested functions.

## Middlewares

- Authentication: JWT validation on all item, export, and admin routes
- Role guard: isAdmin middleware on /admin routes
- Validation: Zod schema check per endpoint (400 on failure)
- Rate limiting: express-rate-limit on /auth routes (~10 attempts / 15 min per IP)
- Security headers: helmet
- Error handler: single error format `{ "error": { "message", "code" } }` with correct status codes (400 / 401 / 403 / 404 / 409 / 500); crash details go to server logs only

## Environment Configurations

**Development (local):** Docker Compose PostgreSQL, .env from committed .env.example, seed script creating a demo user, an admin, and backdated items at every stage (due, overdue, not yet due, archived) so all flows are testable immediately.

**Production:** Neon PostgreSQL (pooled connection string), Vercel serverless deployment, secrets in Vercel environment variables (DATABASE_URL, JWT_SECRET), migrations applied manually via `prisma migrate deploy`, `prisma generate` in the Vercel build step.

Environment variables are never committed; .env is gitignored and .env.example documents every required variable.

## Accepted trade-offs (deliberate)

- The client-supplied "today" date is trusted — a user could only cheat their own schedule (personal tool)
- No refresh tokens — a 7-day access token is the deliberate simplification
- No password recovery in MVP (backlogged with email reminders, file upload, tags, and statistics)
- The frontend UI was originally backlogged too, but was later built as a bonus (all 14 endpoints wired) — see `implementation-journey.md`

## Success Criteria

The project is successful if a user can register, log in, add learning items, see exactly the items due on a given day, review or skip them so items advance through the 2-7-30 schedule and archive after the third review, edit, soft-delete, and export their data (optionally including deleted items); if two users can never see each other's items; if an admin can list, suspend, and unsuspend users and suspended users cannot log in; if all scheduling tests pass in CI; and if the API runs on the deployed Vercel URL with Swagger documentation covering every endpoint.
