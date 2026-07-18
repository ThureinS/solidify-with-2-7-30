const bcrypt = require('bcrypt');
const prisma = require('../src/lib/prisma');
const { parseDate, addDays, toDateString } = require('../src/lib/dates');

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'Demo1234';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'Admin1234';
const SALT_ROUNDS = 10;

function today() {
  return parseDate(new Date().toISOString().slice(0, 10));
}

async function main() {
  const demoUser = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { email: DEMO_EMAIL, passwordHash: await bcrypt.hash(DEMO_PASSWORD, SALT_ROUNDS) },
  });

  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS),
      role: 'ADMIN',
    },
  });

  // Wipe any previously seeded items/reviews so this script is safe to re-run.
  await prisma.review.deleteMany({ where: { item: { userId: demoUser.id } } });
  await prisma.item.deleteMany({ where: { userId: demoUser.id } });

  const t = today();

  const dueStage0 = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Due today: awaiting the 2-day review.',
      dateAdded: addDays(t, -2),
      nextReviewDate: t,
      stage: 0,
    },
  });

  const dueStage1 = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Due today: awaiting the 7-day review.',
      dateAdded: addDays(t, -9),
      nextReviewDate: t,
      stage: 1,
    },
  });
  await prisma.review.create({
    data: { itemId: dueStage1.id, date: addDays(t, -7), result: 'REVIEWED' },
  });

  const dueStage2 = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Due today: awaiting the 30-day review (last one before archiving).',
      dateAdded: addDays(t, -39),
      nextReviewDate: t,
      stage: 2,
    },
  });
  await prisma.review.createMany({
    data: [
      { itemId: dueStage2.id, date: addDays(t, -37), result: 'REVIEWED' },
      { itemId: dueStage2.id, date: addDays(t, -30), result: 'REVIEWED' },
    ],
  });

  const overdue = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Overdue: was due a few days ago and has been sitting in the queue.',
      dateAdded: addDays(t, -5),
      nextReviewDate: addDays(t, -3),
      stage: 0,
    },
  });

  const notYetDue = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Not yet due: next review is a few days from now.',
      dateAdded: t,
      nextReviewDate: addDays(t, 5),
      stage: 0,
    },
  });

  const archived = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Archived: completed all three reviews.',
      dateAdded: addDays(t, -60),
      nextReviewDate: addDays(t, -30),
      stage: 2,
      isComplete: true,
    },
  });
  await prisma.review.createMany({
    data: [
      { itemId: archived.id, date: addDays(t, -58), result: 'REVIEWED' },
      { itemId: archived.id, date: addDays(t, -51), result: 'REVIEWED' },
      { itemId: archived.id, date: addDays(t, -30), result: 'REVIEWED' },
    ],
  });

  console.log(`Seeded demo user (${DEMO_EMAIL} / ${DEMO_PASSWORD}) + admin (${ADMIN_EMAIL} / ${ADMIN_PASSWORD})`);
  console.log(`Demo user has 6 items, anchored at today = ${toDateString(t)}`);
  console.log({
    dueStage0: dueStage0.id,
    dueStage1: dueStage1.id,
    dueStage2: dueStage2.id,
    overdue: overdue.id,
    notYetDue: notYetDue.id,
    archived: archived.id,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
