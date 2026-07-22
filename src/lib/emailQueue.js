const Redis = require('ioredis');
const { Queue } = require('bullmq');

// BullMQ needs its own ioredis connection, separate from lib/redis.js's
// health-check client: BullMQ requires maxRetriesPerRequest: null (it does
// its own retry/blocking logic) and must NOT set enableOfflineQueue: false
// (that would drop jobs instead of queuing them during a Redis blip).
const globalForEmailQueue = global;

function createClient() {
  const client = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  client.on('error', (err) => console.error('Email queue Redis error:', err.message));
  return client;
}

// Same prod null-guard as redis.js: no REDIS_URL (e.g. Vercel today) -> null,
// so callers can skip enqueueing instead of looping reconnect errors.
const emailQueue = process.env.REDIS_URL
  ? new Queue('emails', {
      connection: globalForEmailQueue.__emailQueueRedis || (globalForEmailQueue.__emailQueueRedis = createClient()),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    })
  : null;

module.exports = emailQueue;
