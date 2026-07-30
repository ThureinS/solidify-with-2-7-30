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
const { parseDate, addDays } = require('../src/lib/dates');

const EMAIL = process.env.DEMO_EMAIL || 'stats-test@example.com';
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
  console.log('Expect 4 items due today. Both numbers are relative to TODAY -- reseed on the day you want to show this off.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
