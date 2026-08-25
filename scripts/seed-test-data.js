// Demo data for exercising the completion-rate / streak / history UI with
// something messier than prisma/seed.js's deterministic demo scenario.
// Not part of the graded seed contract -- safe to re-run, only ever touches
// the one account below.
//
// Meant to be run against production too, so the deployed app always has a
// presentable account. Two guards, because a deliberate prod run and an
// accidental one look identical from inside the script:
//   1. The password comes from DEMO_PASSWORD -- never hardcoded here, or it
//      would be a live credential published in a public repo.
//   2. Anything other than a local database needs --confirm.
//
//   local: DEMO_PASSWORD=... node --env-file=.env scripts/seed-test-data.js
//   prod:  DEMO_PASSWORD=... node --env-file=.env.production scripts/seed-test-data.js --confirm
const bcrypt = require('bcrypt');
const prisma = require('../src/lib/prisma');
const { parseDate, addDays, toDateString, daysBetween } = require('../src/lib/dates');
const schedule = require('../src/services/schedule.service');
const { DEMO_ACCOUNT_EMAIL } = require('../src/lib/demoAccount');

const EMAIL = process.env.DEMO_EMAIL || DEMO_ACCOUNT_EMAIL;
const PASSWORD = process.env.DEMO_PASSWORD;

// Host only, never the whole URL -- this gets printed, and the URL has the
// database password in it.
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL).hostname;
  } catch {
    return '';
  }
})();
const isLocal = ['localhost', '127.0.0.1', '::1'].includes(dbHost);

if (!PASSWORD) {
  console.error('Set DEMO_PASSWORD -- this script will not hardcode a password for an account it creates.');
  process.exit(1);
}
if (!dbHost) {
  console.error('DATABASE_URL is missing or unparsable -- refusing to guess which database to seed.');
  process.exit(1);
}
if (!isLocal && !process.argv.includes('--confirm')) {
  console.error(`Refusing to touch a non-local database without --confirm.`);
  console.error(`  database: ${dbHost}`);
  console.error(`  account:  ${EMAIL} (its items and reviews get deleted and rebuilt)`);
  process.exit(1);
}

function today() {
  return parseDate(new Date().toISOString().slice(0, 10));
}

// Runs a fabricated grade sequence through the real schedule.applyReview --
// the same pure function production reviews use -- so an Adaptive demo
// item's difficulty/stability are genuine FSRS output, never hand-picked
// numbers (ADR 0003's spirit: even fake seed data shouldn't misrepresent
// what the algorithm actually computes). The sequence is simulated from a
// nominal start date, then every date is shifted by a constant so the
// *last* review lands `lastReviewDaysAgo` days before `t` -- simulating
// forward from `t` directly isn't possible because each review's due date
// depends on the interval FSRS computes from the previous one, which isn't
// known until it's actually run.
function simulateAdaptiveItem(t, grades, lastReviewDaysAgo) {
  let state = schedule.adaptiveStartOfLife('2000-01-01');
  const reviewDates = [];
  let dueDate = state.nextReviewDate;
  for (const grade of grades) {
    const fakeItem = { mode: 'ADAPTIVE', isComplete: false, ...state };
    const delta = schedule.applyReview(fakeItem, toDateString(dueDate), grade);
    reviewDates.push(dueDate);
    state = { ...state, ...delta };
    dueDate = state.nextReviewDate;
  }

  const shiftDays = daysBetween(reviewDates[reviewDates.length - 1], addDays(t, -lastReviewDaysAgo));
  return {
    dateAdded: addDays(reviewDates[0], shiftDays),
    state: {
      ...state,
      lastReviewDate: addDays(state.lastReviewDate, shiftDays),
      nextReviewDate: addDays(state.nextReviewDate, shiftDays),
    },
    reviewRows: reviewDates.map((date, i) => ({ date: addDays(date, shiftDays), result: 'REVIEWED', grade: grades[i] })),
  };
}

async function main() {
  console.log(`Seeding ${EMAIL} on ${dbHost}${isLocal ? '' : ' (NOT local)'}`);

  // The hash is set on update too, not just create: re-running with a
  // different DEMO_PASSWORD should actually change the password, rather than
  // silently keeping whatever the account was first created with.
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    update: { passwordHash },
    create: { email: EMAIL, passwordHash },
  });

  await prisma.review.deleteMany({ where: { item: { userId: user.id } } });
  await prisma.item.deleteMany({ where: { userId: user.id } });

  const t = today();

  // A handful of items in different states, just so reviews have something
  // to attach to and "All items" has variety too. The unfinished ones are due
  // on the day you seed, not two days later: this fixture exists to be looked
  // at, and a "Due today" tab with nothing in it is the worst first screen.
  const items = await Promise.all(
    [
      { text: 'Capital of Mongolia is Ulaanbaatar', stage: 0, isComplete: false },
      { text: 'React useEffect cleanup runs before the next effect', stage: 1, isComplete: false },
      { text: 'TCP three-way handshake: SYN, SYN-ACK, ACK', stage: 2, isComplete: false },
      { text: 'Mitochondria is the powerhouse of the cell', stage: 2, isComplete: true },
      { text: 'Big-O of binary search is O(log n)', stage: 2, isComplete: true },
      { text: "Prisma's @@index needs both columns for a composite lookup", stage: 1, isComplete: false },
    ].map(({ text, stage, isComplete }) =>
      prisma.item.create({
        data: {
          userId: user.id,
          text,
          dateAdded: addDays(t, -60),
          nextReviewDate: isComplete ? addDays(t, -30) : t,
          stage,
          isComplete,
        },
      })
    )
  );

  // Two Adaptive items, kept out of the `items` array above so addDay()
  // below (which only ever attaches to Fixed items) can't attach an
  // ungraded review row to one at a date that contradicts its simulated
  // FSRS state. One has real review history (via simulateAdaptiveItem, see
  // above); the other is brand new with no history yet, since "no curve
  // yet" (stability: null) is Adaptive's common first state, not a rare
  // edge case (see implementation-journey.md's step 2 entry) -- worth
  // showing honestly rather than only ever seeding "reviewed" items.
  const reviewed3DaysAgo = simulateAdaptiveItem(t, ['GOOD', 'HARD', 'GOOD'], 3);
  const adaptiveReviewed = await prisma.item.create({
    data: {
      userId: user.id,
      text: 'FSRS schedules the next review from Stability, not a fixed ladder',
      dateAdded: reviewed3DaysAgo.dateAdded,
      ...reviewed3DaysAgo.state,
    },
  });
  await prisma.review.createMany({
    data: reviewed3DaysAgo.reviewRows.map((r) => ({ ...r, itemId: adaptiveReviewed.id })),
  });

  await prisma.item.create({
    data: {
      userId: user.id,
      text: "Retrievability is FSRS's predicted recall probability right now",
      dateAdded: t,
      ...schedule.adaptiveStartOfLife(toDateString(t)),
    },
  });

  const rows = [];
  function addDay(dayOffset, reviewed, skipped) {
    const date = addDays(t, dayOffset);
    const item = items[Math.abs(dayOffset) % items.length].id;
    for (let i = 0; i < reviewed; i++) rows.push({ itemId: item, date, result: 'REVIEWED' });
    for (let i = 0; i < skipped; i++) rows.push({ itemId: item, date, result: 'SKIPPED' });
  }

  // Last 90 days: a repeating pattern (rest day / skip-only / mixed / reviewed-only)
  // so the heatmap shows all three states plus real gaps.
  for (let offset = -90; offset <= -8; offset++) {
    const i = -offset;
    if (i % 7 === 0) continue; // gap day, nothing logged
    if (i % 5 === 0) addDay(offset, 0, 1); // skip-only -> 'half'
    else if (i % 3 === 0) addDay(offset, 1, 1); // mixed -> 'half'
    else addDay(offset, (i % 4) + 1, 0); // reviewed-only -> 'full'
  }

  // Last 8 days incl. today: clean unbroken streak, all reviewed-only.
  for (let offset = -7; offset <= 0; offset++) addDay(offset, 1, 0);

  // A few rows from last year, to test the year switcher on the history page.
  for (const offset of [-400, -395, -388, -370]) addDay(offset, 1, 0);

  await prisma.review.createMany({ data: rows });

  const reviewed = rows.filter((r) => r.result === 'REVIEWED').length;
  // Password deliberately not echoed -- it's yours, in DEMO_PASSWORD, and
  // terminal scrollback and CI logs both outlive this run.
  console.log(`Seeded ${EMAIL} (password: whatever you passed as DEMO_PASSWORD)`);
  console.log(`${rows.length} review rows (${reviewed} reviewed, ${rows.length - reviewed} skipped)`);
  console.log('Expect current streak = 14 days (base pattern fills back to day -13, gap at day -14), plus 4 rows from ~last year');
  console.log('Expect 5 items due today (4 Fixed + 1 brand-new Adaptive item with no review history yet).');
  console.log('Plus 1 Adaptive item reviewed 3 times (last review 3 days ago, not due yet) -- shows a real memory-decay curve.');
  console.log('All of the above are relative to TODAY -- reseed on the day you want to show this off.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
