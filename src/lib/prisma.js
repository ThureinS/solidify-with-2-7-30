const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// Serverless functions can each spin up a fresh module scope, so we stash
// the client on `global` to survive hot-reloads/re-invocations and avoid
// opening a new pool of database connections every time.
const globalForPrisma = global;

// Postgres cancels any single SQL statement that runs longer than this
// (error code 57014), so a runaway query fails fast with a 500 instead of
// holding a connection until Vercel kills the function. Every query in this
// app takes well under 1 ms at today's size and stays in single-digit ms at
// 100k items (docs/query-plans.md), so 10 s is a huge safety margin that
// only a truly broken query will ever hit.
const STATEMENT_TIMEOUT_MS = 10_000;

// pg sends statement_timeout as a *startup parameter* when it opens a
// connection. Neon's pooled URL (host contains "-pooler") goes through
// PgBouncer, which rejects startup parameters it doesn't know -- Neon's
// pgbouncer.ini only whitelists extra_float_digits -- so sending it there
// could make every connection fail. On the pooler, the same 10 s limit is
// set once on the database role instead (README, "Deploying" step 4).
const usesNeonPooler = /-pooler\./.test(process.env.DATABASE_URL || '');

function createClient() {
  // Explicit pool sizing rather than pg's bare defaults (max: 10,
  // idleTimeoutMillis: 10000, connectionTimeoutMillis: 0 -- i.e. wait
  // forever). A capped max matters most in production, where each
  // serverless invocation can open its own pool against Neon's shared
  // connection limit; connectionTimeoutMillis makes a starved pool fail
  // fast (a 500) instead of a request hanging indefinitely.
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(usesNeonPooler ? {} : { statement_timeout: STATEMENT_TIMEOUT_MS }),
  });
  return new PrismaClient({ adapter });
}

const prisma = globalForPrisma.__prisma || createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
