const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// Serverless functions can each spin up a fresh module scope, so we stash
// the client on `global` to survive hot-reloads/re-invocations and avoid
// opening a new pool of database connections every time.
const globalForPrisma = global;

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
  });
  return new PrismaClient({ adapter });
}

const prisma = globalForPrisma.__prisma || createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
