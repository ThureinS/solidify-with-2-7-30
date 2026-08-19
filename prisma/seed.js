const bcrypt = require('bcrypt');
const prisma = require('../src/lib/prisma');
const { parseDate, addDays, toDateString } = require('../src/lib/dates');

const DEMO_EMAIL = 'demo@example.com';
const DEMO_PASSWORD = 'Demo1234';
const ADMIN_EMAIL = 'admin@example.com';
const ADMIN_PASSWORD = 'Admin1234';
const SALT_ROUNDS = 10;

// Scenery for the admin panel -- never meant to be logged into, just enough
// rows so "Active" and "Suspended" both render without anyone clicking
// Suspend first. Password is unused but still real-hashed, not a placeholder
// string, so nothing here reads as a shortcut if someone inspects the table.
const EXTRA_USERS = [
  { email: 'alice@example.com', isSuspended: false },
  { email: 'bob@example.com', isSuspended: false },
  { email: 'carla@example.com', isSuspended: true },
];

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

  for (const u of EXTRA_USERS) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: { email: u.email, passwordHash: await bcrypt.hash('Placeholder1', SALT_ROUNDS), isSuspended: u.isSuspended },
    });
  }

  // Wipe any previously seeded items/reviews so this script is safe to re-run.
  await prisma.review.deleteMany({ where: { item: { userId: demoUser.id } } });
  await prisma.item.deleteMany({ where: { userId: demoUser.id } });

  const t = today();

  // The six items below exercise every stage/queue state the UI can show
  // (due at each of the three stages, overdue, not-yet-due, archived). Text
  // reads as an actual thing someone jotted down, not a label for the state
  // it demonstrates -- a screen full of "Due today: awaiting the 2-day
  // review" rows reads like test fixtures, not a spaced-repetition tracker.
  const dueStage0 = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: "Neural nets: backpropagation is just the chain rule applied layer by layer, backward through the network.",
      dateAdded: addDays(t, -2),
      nextReviewDate: t,
      stage: 0,
    },
  });

  const dueStage1 = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Big-O describes how runtime grows with input size, not actual speed -- O(n) can beat O(1) for small inputs.',
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
      text: 'SQL joins: INNER keeps only matches on both sides; LEFT keeps every row from the left table even without one.',
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
      text: "The Great Wall of China isn't actually visible from space with the naked eye -- that one's a myth.",
      dateAdded: addDays(t, -5),
      nextReviewDate: addDays(t, -3),
      stage: 0,
    },
  });

  const notYetDue = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: "HTTP 429 means 'Too Many Requests' -- the standard status code for rate limiting.",
      dateAdded: t,
      nextReviewDate: addDays(t, 5),
      stage: 0,
    },
  });

  const archived = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: 'Git rebase rewrites commit history; git merge preserves it. Rebase for a clean local branch, merge for shared history.',
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

  // Five more items, each added so its first review lands on one of the last
  // five days -- a believable "kept up with it" trail rather than one lone
  // data point. This is what actually puts a number on the streak stat and
  // the weekly recap line, and the moon-history page, which are otherwise
  // empty right after a fresh seed (they're computed from real Review rows,
  // not from the item list). The last one is a skip, not a review, so the
  // history page's half-moon state and the completion-rate stat (normally
  // stuck at 100%) both show something real too.
  const streakReviewed = [
    { daysAgoAdded: 7, daysAgoReviewed: 5, text: "Photosynthesis' light reactions happen in the thylakoid membrane; the Calvin cycle runs in the stroma." },
    { daysAgoAdded: 6, daysAgoReviewed: 4, text: "TCP guarantees delivery order; UDP doesn't bother, which is why it's used for video calls and games." },
    { daysAgoAdded: 5, daysAgoReviewed: 3, text: "Amdahl's Law: the speedup from parallelizing a task is capped by its sequential portion, no matter how many cores you add." },
    { daysAgoAdded: 4, daysAgoReviewed: 2, text: "A hash table's average lookup is O(1), but a bad hash function collapses that to O(n) worst case." },
  ];
  for (const s of streakReviewed) {
    const item = await prisma.item.create({
      data: {
        userId: demoUser.id,
        text: s.text,
        // Created already in its post-review state (stage 1, next review 7
        // days out from the day it was reviewed) -- the item's current state
        // and its Review history are two separate rows, so there's no need
        // to create-then-update through the transient pre-review state.
        dateAdded: addDays(t, -s.daysAgoAdded),
        nextReviewDate: addDays(t, -s.daysAgoReviewed + 7),
        stage: 1,
      },
    });
    await prisma.review.create({
      data: { itemId: item.id, date: addDays(t, -s.daysAgoReviewed), result: 'REVIEWED' },
    });
  }

  const streakSkipped = await prisma.item.create({
    data: {
      userId: demoUser.id,
      text: "The Krebs cycle produces most of a cell's ATP indirectly, by generating electron carriers for the electron transport chain.",
      dateAdded: addDays(t, -3),
      // Skipping doesn't change stage, just pushes nextReviewDate a day past
      // the skip date -- so this item is due again today, same as a real
      // skip-then-reopen would leave it.
      nextReviewDate: t,
      stage: 0,
    },
  });
  await prisma.review.create({
    data: { itemId: streakSkipped.id, date: addDays(t, -1), result: 'SKIPPED' },
  });

  console.log(`Seeded demo user (${DEMO_EMAIL} / ${DEMO_PASSWORD}) + admin (${ADMIN_EMAIL} / ${ADMIN_PASSWORD})`);
  console.log(`Plus ${EXTRA_USERS.length} extra users for the admin panel (not meant to be logged into)`);
  console.log(`Demo user has 11 items and a 5-day review streak, anchored at today = ${toDateString(t)}`);
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
