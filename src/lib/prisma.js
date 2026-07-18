const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

// Serverless functions can each spin up a fresh module scope, so we stash
// the client on `global` to survive hot-reloads/re-invocations and avoid
// opening a new pool of database connections every time.
const globalForPrisma = global;

function createClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

const prisma = globalForPrisma.__prisma || createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
