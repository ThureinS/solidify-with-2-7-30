# Frontend

A minimal React (Vite) UI for the Spaced Repetition Review Tracker API.
Bonus scope, not part of the original course spec -- kept isolated in this
folder with its own `package.json`, not wired into the backend's CI/deploy.

Wires all 14 backend endpoints: register/login, add an item, see what's due
today and review/skip it (with a click-through detail view showing full
text, dates, and review history), browse/edit/soft-delete items in "All
items" (paginated, filterable), export your data as a JSON download
(optionally including deleted items), and -- for the seeded admin account --
list, suspend, and unsuspend users.

## Running locally

```bash
cp .env.example .env   # points at the local backend by default
npm install
npm run dev            # http://localhost:5173
```

The backend must also be running locally (see the root README) with
`CORS_ORIGIN` allowing `http://localhost:5173` (the default).
