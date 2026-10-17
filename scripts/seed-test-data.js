// Demo data for exercising the completion-rate / streak / history UI with
// something messier than prisma/seed.js's deterministic demo scenario.
// Not part of the graded seed contract -- safe to re-run, only ever touches
// the one account below.
//
// The fixture itself (items, review rows, dates) lives in ./seedFixture.js,
// kept pure so tests/seedFixture.test.js can replay every row through the
// real schedule functions. Every row here is one the app could really have
// produced: reviews follow each item's actual 2-7-30 or FSRS schedule, so no
// row is dated before its item was added and nothing is reviewed after it
// archives. (The old version handed rows out round-robin and produced
// impossible histories -- found 2026-10-07, see developer-handover.md.)
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
const { parseDate, toDateString } = require('../src/lib/dates');
const { buildFixture } = require('./seedFixture');
const itemsService = require('../src/services/items.service');
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
  const todayStr = toDateString(t);
  const fixture = buildFixture(t);

  // One create per item (not createMany) because each review row needs its
  // own item's fresh id.
  const rows = [];
  for (const spec of fixture) {
    const item = await prisma.item.create({
      data: { userId: user.id, text: spec.text, dateAdded: spec.dateAdded, ...spec.state },
    });
    for (const row of spec.reviews) rows.push({ itemId: item.id, ...row });
  }
  await prisma.review.createMany({ data: rows });

  // The summary is read back from the database through the same service
  // functions the API uses -- never hand-written "expect" lines, which drift
  // the moment the fixture changes (the old version predicted "streak 14,
  // 164 rows" and had to be kept in sync by hand).
  const streak = await itemsService.getCurrentStreak(user.id, todayStr);
  const due = await itemsService.listDueItems(user.id, todayStr);
  const overdue = due.filter((item) => toDateString(item.nextReviewDate) < todayStr).length;

  const fixed = fixture.filter((item) => item.state.mode === 'FIXED');
  const archived = fixed.filter((item) => item.state.isComplete).length;
  const reviewed = rows.filter((row) => row.result === 'REVIEWED').length;

  // Password deliberately not echoed -- it's yours, in DEMO_PASSWORD, and
  // terminal scrollback and CI logs both outlive this run.
  console.log(`Seeded ${EMAIL} (password: whatever you passed as DEMO_PASSWORD)`);
  console.log(`${fixture.length} items (${fixed.length} Fixed, ${archived} archived; ${fixture.length - fixed.length} Adaptive)`);
  console.log(`${rows.length} review rows (${reviewed} reviewed, ${rows.length - reviewed} skipped)`);
  console.log(`Current streak: ${streak} day(s)  (items.service.getCurrentStreak)`);
  console.log(`Due today: ${due.length} items, ${overdue} of them overdue  (items.service.listDueItems)`);
  console.log('All of the above are relative to TODAY -- reseed on the day you want to show this off.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
