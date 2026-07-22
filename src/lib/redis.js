const Redis = require('ioredis');

// Same global-singleton trick as prisma.js: a fresh module scope (hot-reload,
// serverless re-invocation) would otherwise open a new Redis connection each
// time. Stashing the client on `global` keeps it to one.
const globalForRedis = global;

function createClient() {
  // enableOfflineQueue: false -> commands reject immediately when Redis is
  // unreachable instead of buffering until it reconnects. Without it, a health
  // ping (or any command) HANGS during an outage rather than failing fast.
  const client = new Redis(process.env.REDIS_URL, { enableOfflineQueue: false });
  // ioredis emits 'error' when Redis is unreachable, and an EventEmitter with
  // no 'error' listener THROWS -- which would crash the whole API on a Redis
  // blip. Logging instead lets the app stay up (it just can't queue jobs).
  client.on('error', (err) => console.error('Redis error:', err.message));
  return client;
}

// No REDIS_URL (e.g. prod on Vercel, which has no Redis yet) -> export null
// rather than a client that would loop reconnect errors against a server that
// isn't there. Callers must handle a null client until a managed Redis (Upstash)
// is wired up in prod.
const redis = process.env.REDIS_URL ? globalForRedis.__redis || createClient() : null;

if (process.env.NODE_ENV !== 'production' && redis) {
  globalForRedis.__redis = redis;
}

module.exports = redis;
