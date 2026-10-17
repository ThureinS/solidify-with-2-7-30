// Demo fixture for scripts/seed-test-data.js: given "today", builds the exact
// set of items and review rows the demo account should have. Pure -- no
// database, no randomness -- so tests/seedFixture.test.js can replay every
// row through the same schedule functions production uses and prove each
// history is one the app could really have produced.
//
// This file replaced the old round-robin row sprinkle, which gave items
// reviews before their dateAdded, 20+ reviews at stage 0, and a review and a
// skip on the same day (found 2026-10-07; see developer-handover.md and
// implementation-journey.md). ADR 0003's rule applies to fixture data too:
// showcase data must not misrepresent what the app can produce.
//
// Ground rules, all pinned by tests/seedFixture.test.js:
//   - rows come from the real applyReview/applySkip, walked day by day from
//     each item's start-of-life state, so nothing can be reviewed early,
//     twice in one day, or after archiving;
//   - when the walk ends on the seed day, several items are deliberately
//     still waiting (a LATE personality, or FORGOT -- never acted on), so a
//     freshly seeded demo opens with a real "Due today" queue, one item 5
//     days overdue for U7, and a partially handled day to watch fill in;
//   - personalities (below) spread reviews and skips out in time, so the
//     calendar keeps its full/half/empty texture and a real streak.
const { parseDate, addDays, toDateString, daysBetween } = require('../src/lib/dates');
const schedule = require('../src/services/schedule.service');

const FINAL_INTERVAL_DAYS = 30; // the graded spec's final rung (CONTEXT.md)

// How a simulated Fixed item behaves on a day it finds itself due. Arguments:
//   daysOverdue -- days since nextReviewDate
//   skips       -- consecutive SKIPs already recorded for this rung
// The `skips` counter is needed because applySkip moves nextReviewDate
// forward by one day: "how many days overdue" alone can't tell "skip once,
// then review tomorrow" from "skip every single day".
// PROMPT/SKIP_* days render as 'full' and 'half' on the History page; LATE1/
// LATE2 leave a one- or two-day gap between the due date and the row;
// FORGOT is never acted on, which is how the fixture keeps one honestly
// overdue item (a real user forgets; the demo needs one).
const PERSONALITIES = {
  PROMPT: (daysOverdue) => (daysOverdue === 0 ? 'REVIEW' : 'WAIT'),
  SKIP_ONCE: (daysOverdue, skips) =>
    daysOverdue > 0 ? 'WAIT' : skips === 0 ? 'SKIP' : skips === 1 ? 'REVIEW' : 'WAIT',
  SKIP_TWICE: (daysOverdue, skips) =>
    daysOverdue > 0 ? 'WAIT' : skips < 2 ? 'SKIP' : 'REVIEW',
  LATE1: (daysOverdue) => (daysOverdue === 1 ? 'REVIEW' : 'WAIT'),
  LATE2: (daysOverdue) => (daysOverdue === 2 ? 'REVIEW' : 'WAIT'),
  FORGOT: () => 'WAIT',
};

function simulateFixedItem(today, daysAgo, text, personality) {
  const dateAdded = toDateString(addDays(today, -daysAgo));
  let state = schedule.fixedStartOfLife(dateAdded, FINAL_INTERVAL_DAYS);
  const reviews = [];
  let skips = 0;

  // Walk day by day from dateAdded through the seed day itself. The
  // personalities decide what is left behind when the walk ends: LATE ones
  // are still waiting on (or just before) their action day, and FORGOT is
  // never acted on at all -- those are the items a demo finds due.
  for (let day = parseDate(dateAdded); day <= today; day = addDays(day, 1)) {
    if (!schedule.isDueOn(state, toDateString(day))) continue;
    const action = PERSONALITIES[personality](daysBetween(state.nextReviewDate, day), skips);
    if (action === 'WAIT') continue;

    // The real functions, not a copy of their math: an impossible sequence
    // (early review, review after archive) throws here instead of quietly
    // seeding a history the app could never have produced. Deliberately not
    // wrapped in try/catch -- a broken personality should fail the seed.
    const delta =
      action === 'REVIEW'
        ? schedule.applyReview(state, toDateString(day))
        : schedule.applySkip(state, toDateString(day));
    state = { ...state, ...delta };
    skips = action === 'SKIP' ? skips + 1 : 0;
    reviews.push({ date: day, result: action === 'REVIEW' ? 'REVIEWED' : 'SKIPPED', grade: null });
  }

  return { text, dateAdded: parseDate(dateAdded), state, reviews };
}

// One Adaptive item with real FSRS history: runs a fabricated grade sequence
// through the real applyReview, so difficulty/stability are genuine FSRS
// output, never hand-picked numbers. Simulated from a nominal start date,
// then every date is shifted by a constant so the *last* review lands
// `lastReviewDaysAgo` days before today -- simulating forward from today
// directly isn't possible because each review's due date depends on the
// interval FSRS computes from the previous one, which isn't known until it
// has actually been run.
function simulateAdaptiveItem(today, grades, lastReviewDaysAgo) {
  let state = schedule.adaptiveStartOfLife('2000-01-01');
  const reviewDates = [];
  let dueDate = state.nextReviewDate;
  for (const grade of grades) {
    const delta = schedule.applyReview({ ...state }, toDateString(dueDate), grade);
    reviewDates.push(dueDate);
    state = { ...state, ...delta };
    dueDate = state.nextReviewDate;
  }

  const shiftDays = daysBetween(reviewDates[reviewDates.length - 1], addDays(today, -lastReviewDaysAgo));
  return {
    dateAdded: addDays(reviewDates[0], shiftDays),
    state: {
      ...state,
      lastReviewDate: addDays(state.lastReviewDate, shiftDays),
      nextReviewDate: addDays(state.nextReviewDate, shiftDays),
    },
    reviews: reviewDates.map((date, i) => ({ date: addDays(date, shiftDays), result: 'REVIEWED', grade: grades[i] })),
  };
}

// Three Fixed items from ~13 months ago: their whole ladder runs in the
// previous calendar year, which is what the History page's year switcher
// needs. All three archive (a Fixed item archives on its third review), so
// the All-items view also gets its "archived" states from these.
const OLD_FIXED = [
  { daysAgo: 400, personality: 'PROMPT', text: 'CORS answers an OPTIONS preflight before a cross-site request' },
  { daysAgo: 385, personality: 'SKIP_ONCE', text: 'EXPLAIN ANALYZE runs a query for real and prints the plan it chose' },
  { daysAgo: 370, personality: 'LATE1', text: 'Index scans beat sequential scans once a table grows' },
];

// One Fixed item added per day for the last two weeks: a lived-in calendar
// (full/half/empty days, a real streak) plus the states a demo needs. What
// the walk leaves due on the seed day: the two items added 2 days ago (one
// waiting on LATE1, one never touched), the LATE2 one added 3 days ago
// (1 day overdue), and the FORGOT one added 7 days ago (5 days overdue for
// U7). Items sit at every stage, from 0 to 2.
const RECENT_FIXED = [
  { daysAgo: 14, personality: 'PROMPT', text: 'Capital of Mongolia is Ulaanbaatar' },
  { daysAgo: 13, personality: 'SKIP_ONCE', text: 'React useEffect cleanup runs before the next effect' },
  { daysAgo: 12, personality: 'LATE1', text: 'TCP three-way handshake: SYN, SYN-ACK, ACK' },
  { daysAgo: 11, personality: 'SKIP_TWICE', text: 'Mitochondria is the powerhouse of the cell' },
  { daysAgo: 10, personality: 'LATE2', text: 'Big-O of binary search is O(log n)' },
  { daysAgo: 9, personality: 'PROMPT', text: "Prisma's @@index needs both columns for a composite lookup" },
  { daysAgo: 8, personality: 'LATE2', text: 'V8 compiles hot functions just in time' },
  { daysAgo: 7, personality: 'FORGOT', text: 'Redis is an in-memory key-value store' },
  { daysAgo: 6, personality: 'SKIP_ONCE', text: 'HTTP 401 means unauthenticated; 403 means forbidden' },
  { daysAgo: 5, personality: 'PROMPT', text: 'A Postgres DATE column has no time component' },
  { daysAgo: 4, personality: 'SKIP_TWICE', text: 'A JWT is header.payload.signature, base64url-encoded' },
  { daysAgo: 3, personality: 'LATE2', text: 'git rebase rewrites commits; merge keeps both histories' },
  { daysAgo: 2, personality: 'LATE1', text: 'Docker containers share the host kernel' },
  { daysAgo: 2, personality: 'FORGOT', text: 'CSS Grid places items in two dimensions; Flexbox in one' },
  { daysAgo: 1, personality: 'PROMPT', text: 'Vitest reuses the Vite transform pipeline' },
  { daysAgo: 0, personality: 'PROMPT', text: 'Bcrypt salts every password hash' },
];

// Returns an array of:
//   { text, dateAdded, state, reviews }
// `state` holds exactly the schedule columns to write to Item (mode, stage,
// isComplete, nextReviewDate, finalIntervalDays, difficulty, stability,
// lastReviewDate); `reviews` holds { date, result, grade } rows to attach to
// the created item. Dates are UTC-midnight Date objects.
function buildFixture(today) {
  const items = [];

  for (const { daysAgo, text, personality } of [...OLD_FIXED, ...RECENT_FIXED]) {
    items.push(simulateFixedItem(today, daysAgo, text, personality));
  }

  // Adaptive items, kept in spirit from the first fixture: one with a real
  // FSRS history ending 3 days ago (an item page that can show the decay
  // curve) and one brand new and due immediately -- "no curve yet" is
  // Adaptive's common first state, not a rare edge case, so it is shown too.
  items.push({
    text: 'FSRS schedules the next review from Stability, not a fixed ladder',
    ...simulateAdaptiveItem(today, ['GOOD', 'HARD', 'GOOD'], 3),
  });
  items.push({
    text: "Retrievability is FSRS's predicted recall probability right now",
    dateAdded: today,
    state: schedule.adaptiveStartOfLife(toDateString(today)),
    reviews: [],
  });

  return items;
}

module.exports = { buildFixture };
