# Frontend

A minimal React (Vite) UI for the Spaced Repetition Review Tracker API.
Bonus scope, not part of the original course spec -- kept isolated in this
folder with its own `package.json`, not wired into the backend's CI/deploy.

Covers the core loop only: register/login, add an item, see what's due
today, review or skip it. Editing/deleting items, export, and the admin
screens are backend-only for now (use Swagger at `/api/v1/docs` for those).

## Running locally

```bash
cp .env.example .env   # points at the local backend by default
npm install
npm run dev            # http://localhost:5173
```

The backend must also be running locally (see the root README) with
`CORS_ORIGIN` allowing `http://localhost:5173` (the default).
