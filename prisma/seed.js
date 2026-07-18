const prisma = require('../src/lib/prisma');
const { DEV_USER_ID } = require('../src/lib/devUser');
const { parseDate, addDays, toDateString } = require('../src/lib/dates');

function today() {
  return parseDate(new Date().toISOString().slice(0, 10));
}

async function main() {
  await prisma.user.upsert({
    where: { id: DEV_USER_ID },
    update: {},
    create: {
      id: DEV_USER_ID,
      email: 'dev@example.com',
      passwordHash: 'placeholder-until-part-5-auth',
    },
  });

  // Wipe any previously seeded items/reviews so this script is safe to re-run.
  await prisma.review.deleteMany({ where: { item: { userId: DEV_USER_ID } } });
  await prisma.item.deleteMany({ where: { userId: DEV_USER_ID } });

  const t = today();

  const dueStage0 = await prisma.item.create({
    data: {
      userId: DEV_USER_ID,
      text: 'Due today: awaiting the 2-day review.',
      dateAdded: addDays(t, -2),
      nextReviewDate: t,
      stage: 0,
    },
  });

  const dueStage1 = await prisma.item.create({
    data: {
      userId: DEV_USER_ID,
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
      userId: DEV_USER_ID,
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
      userId: DEV_USER_ID,
      text: 'Overdue: was due a few days ago and has been sitting in the queue.',
      dateAdded: addDays(t, -5),
      nextReviewDate: addDays(t, -3),
      stage: 0,
    },
  });

  const notYetDue = await prisma.item.create({
    data: {
      userId: DEV_USER_ID,
      text: 'Not yet due: next review is a few days from now.',
      dateAdded: t,
      nextReviewDate: addDays(t, 5),
      stage: 0,
    },
  });

  const archived = await prisma.item.create({
    data: {
      userId: DEV_USER_ID,
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

  console.log(`Seeded dev user + 6 items, anchored at today = ${toDateString(t)}`);
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
