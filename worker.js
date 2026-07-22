const { Worker } = require('bullmq');
const Redis = require('ioredis');
const nodemailer = require('nodemailer');

const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
connection.on('error', (err) => console.error('Worker Redis error:', err.message));

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

async function processJob(job) {
  const { email } = job.data;
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: email,
    subject: 'Welcome to Spaced Repetition Review Tracker',
    text: 'Thanks for signing up! Start adding items and we\'ll help you review them on the 2-7-30 schedule.',
  });
  console.log(`Sent welcome email to ${email}`);
}

const worker = new Worker('emails', processJob, { connection });

worker.on('completed', (job) => console.log(`Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`Job ${job?.id} failed:`, err.message));
worker.on('error', (err) => console.error('Worker error:', err.message));

console.log('Email worker started, listening on queue "emails"');

async function shutdown() {
  console.log('Shutting down worker...');
  await worker.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
