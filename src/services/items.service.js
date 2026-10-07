const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { parseDate, addDays, toDateString, daysBetween } = require('../lib/dates');
const schedule = require('./schedule.service');
const fsrs = require('./fsrs.service');

async function createItem(userId, { text, date, mode, finalIntervalDays }) {
  const dateAdded = parseDate(date);
  const startState =
    mode === 'ADAPTIVE'
      ? schedule.adaptiveStartOfLife(date)
      : schedule.fixedStartOfLife(date, finalIntervalDays);
  return prisma.item.create({
    data: { userId, text, dateAdded, ...startState },
  });
}

async function listItems(userId, { status, page, limit }) {
  const where = { userId, deletedAt: null };
  if (status === 'active') where.isComplete = false;
  if (status === 'archived') where.isComplete = true;

  const [items, total] = await Promise.all([
    prisma.item.findMany({
      where,
      orderBy: { nextReviewDate: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.item.count({ where }),
  ]);

  return { items, total };
}

async function getItemById(userId, id) {
  const item = await prisma.item.findFirst({
    where: { id, userId, deletedAt: null },
    include: { reviews: { orderBy: { date: 'asc' } } },
  });
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  return item;
}

async function updateItemText(userId, id, text) {
  const { count } = await prisma.item.updateMany({
    where: { id, userId, deletedAt: null },
    data: { text },
  });
  if (count === 0) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  return getItemById(userId, id);
}

async function softDeleteItem(userId, id) {
  const { count } = await prisma.item.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (count === 0) throw new AppError(404, 'NOT_FOUND', 'Item not found');
}

async function listDueItems(userId, date) {
  return prisma.item.findMany({
    where: { userId, deletedAt: null, isComplete: false, nextReviewDate: { lte: parseDate(date) } },
    orderBy: { nextReviewDate: 'asc' },
  });
}

async function findOwnedItem(userId, id) {
  const item = await prisma.item.findFirst({ where: { id, userId, deletedAt: null } });
  if (!item) throw new AppError(404, 'NOT_FOUND', 'Item not found');
  return item;
}

async function reviewItem(userId, id, date, grade) {
  const item = await findOwnedItem(userId, id);
  const nextState = schedule.applyReview(item, date, grade); // throws AppError if not allowed

  await prisma.$transaction([
    prisma.review.create({
      data: {
        itemId: id,
        date: parseDate(date),
        result: 'REVIEWED',
        grade: item.mode === 'ADAPTIVE' ? grade : null,
      },
    }),
    prisma.item.update({ where: { id }, data: nextState }),
  ]);
  return getItemById(userId, id);
}

// Reset: wipes progress back to the item's own mode's start-of-life state
// (CONTEXT.md). A Fixed item keeps its existing finalIntervalDays -- that's
// a setting, not progress. Writes no Review row: this isn't a review or a
// skip, and deriveStreak/deriveReviewHistory would misread one as activity.
async function resetItem(userId, id, date) {
  const item = await findOwnedItem(userId, id);
  const startState =
    item.mode === 'ADAPTIVE'
      ? schedule.adaptiveStartOfLife(date)
      : schedule.fixedStartOfLife(date, item.finalIntervalDays);
  await prisma.item.update({ where: { id }, data: startState });
  return getItemById(userId, id);
}

// Mode switch: always a full reset onto the *new* mode's start-of-life
// state, never a converted carry-over (CONTEXT.md) -- same underlying
// operation as resetItem, just landing on a possibly-different mode.
// finalIntervalDays only matters when switching to Fixed; if omitted, the
// item's current value carries over (e.g. Fixed -> Adaptive -> back to
// Fixed keeps the original setting unless the caller overrides it).
async function switchItemMode(userId, id, { mode, date, finalIntervalDays }) {
  const item = await findOwnedItem(userId, id);
  const startState =
    mode === 'ADAPTIVE'
      ? schedule.adaptiveStartOfLife(date)
      : schedule.fixedStartOfLife(date, finalIntervalDays ?? item.finalIntervalDays);
  await prisma.item.update({ where: { id }, data: startState });
  return getItemById(userId, id);
}

// Retrievability curve: the item's own real Difficulty/Stability run
// through fsrs.retrievabilityCurve -- never a mocked line (ADR 0003). No
// curve exists before an item's first graded review, so a Fixed item or an
// unreviewed Adaptive one gets an empty list, never a flat/defaulted line.
async function getRetrievabilityCurve(userId, id, date) {
  const item = await getItemById(userId, id);
  // A Fixed item, or an Adaptive one with no graded review yet, has no curve.
  // That's a normal answer, not an error: the item page asks for the curve at
  // the same time as the item, before it knows the mode.
  if (item.mode !== 'ADAPTIVE' || item.stability == null) {
    return { points: [] };
  }

  const elapsedDays = date ? daysBetween(item.lastReviewDate, parseDate(date)) : null;
  const points = fsrs.retrievabilityCurve(item.stability, elapsedDays ?? 0);
  const today =
    elapsedDays == null ? undefined : { day: elapsedDays, retrievability: fsrs.retrievability(item.stability, elapsedDays) };
  return { points, today };
}

async function skipItem(userId, id, date) {
  const item = await findOwnedItem(userId, id);
  const nextState = schedule.applySkip(item, date); // throws AppError if not allowed

  await prisma.$transaction([
    prisma.review.create({ data: { itemId: id, date: parseDate(date), result: 'SKIPPED' } }),
    prisma.item.update({ where: { id }, data: nextState }),
  ]);
  return getItemById(userId, id);
}

// Pure: turns Review.groupBy([date, result]) rows into one entry per active
// day, with a 3-state read: 'full' (reviewed, nothing skipped that day),
// 'half' (any skip that day, alone or mixed with a review -- skipping is a
// legitimate action, not a lesser one). A day with no Review rows at all is
// simply absent -- the caller renders that as the empty/new-moon state.
function deriveReviewHistory(groupedRows) {
  const byDate = new Map();
  for (const row of groupedRows) {
    const dateStr = row.date.toISOString().slice(0, 10);
    const day = byDate.get(dateStr) || { date: dateStr, reviewCount: 0, skipCount: 0 };
    if (row.result === 'REVIEWED') day.reviewCount += row._count;
    else day.skipCount += row._count;
    byDate.set(dateStr, day);
  }

  return [...byDate.values()]
    .map((day) => ({ ...day, state: day.skipCount > 0 ? 'half' : 'full' }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Sparse and scoped to one year on purpose: payload size grows with actual
// activity, not with the size of the calendar or how many years have passed.
async function getReviewHistory(userId, year) {
  const grouped = await prisma.review.groupBy({
    by: ['date', 'result'],
    where: {
      item: { userId, deletedAt: null },
      date: { gte: parseDate(`${year}-01-01`), lte: parseDate(`${year}-12-31`) },
    },
    _count: true,
  });

  return deriveReviewHistory(grouped);
}

// Pure: counts consecutive active days walking back from `today`. If today
// has no activity yet, the streak isn't broken until the day actually ends
// -- it counts back from yesterday instead, so reviewing later today still
// extends it. `activeDates` must be distinct date strings, any order.
//
// "Active" means any Review row, REVIEWED or SKIPPED -- a skip-only day keeps
// the streak alive, because the streak measures showing up, and this app
// treats skipping as a legitimate scheduling action (see the history page's
// copy). Note this is deliberately a different question from the completion
// rate, which counts skips on the negative side: the streak asks "did you
// open the app?", completion asks "did you get through it?". Two honest
// answers, not a contradiction.
function deriveStreak(activeDates, today) {
  const active = new Set(activeDates);
  let anchor = active.has(today) ? parseDate(today) : addDays(parseDate(today), -1);
  let streak = 0;
  while (active.has(toDateString(anchor))) {
    streak += 1;
    anchor = addDays(anchor, -1);
  }
  return streak;
}

// All-time on purpose, unlike getReviewHistory's year scope -- a streak that
// reset every January 1st for crossing a year boundary would just be wrong.
// groupBy, not findMany + distinct: Prisma's `distinct` dedupes client-side
// (it fetches every matching row first), groupBy emits a real SQL GROUP BY.
// ponytail: no date lower bound, so rows grow with the account's lifetime --
// add `date: { gte: today - ~400d }` if that ever matters, accepting that a
// streak longer than the window would then undercount.
async function getCurrentStreak(userId, today) {
  const rows = await prisma.review.groupBy({
    by: ['date'],
    where: { item: { userId, deletedAt: null } },
  });
  return deriveStreak(rows.map((r) => toDateString(r.date)), today);
}

// Pure: buckets Review.groupBy([date, result]) rows into ISO weeks
// (Monday-anchored), summing raw REVIEWED/SKIPPED counts. Counts only, never
// a ratio -- a reviewed/skipped fraction needs a denominator of "items due
// that week", which isn't stored, so charting one would claim a rate the
// data can't support (ADR 0003, the same trap Dashboard.jsx's completion
// stat already documents: it can't tell 2-for-2 from 40-for-40).
//
// Every week between the first active one and the last is present, empty
// ones as 0/0 -- leaving them out made a 9-month gap look like one week on
// the chart (ADR 0003). today (the client's YYYY-MM-DD, optional) extends
// the run of zero weeks up to the current week; without it the list stops
// at the last active week rather than guessing "now" from the server clock.
// No rows at all stays [] -- an account with no reviews has no first week.
function deriveWeeklyStats(groupedRows, today) {
  const byWeek = new Map();
  for (const row of groupedRows) {
    const weekStart = mondayOf(row.date);
    const week = byWeek.get(weekStart) || { weekStart, reviewed: 0, skipped: 0 };
    if (row.result === 'REVIEWED') week.reviewed += row._count;
    else week.skipped += row._count;
    byWeek.set(weekStart, week);
  }
  if (byWeek.size === 0) return [];

  const active = [...byWeek.keys()].sort();
  let first = active[0];
  let last = active[active.length - 1];
  // today earlier than the last review (a client clock that's off, or a
  // review logged with a later date) never hides real weeks -- end at
  // whichever is later.
  if (today && mondayOf(parseDate(today)) > last) last = mondayOf(parseDate(today));

  // Both ends are client-provided dates, so a stray far-future one (e.g.
  // date=9999-12-31) would otherwise loop over ~400k weeks. Ten years is
  // far beyond any real account here; past that, keep the most recent.
  // Clamped before the loop, not sliced after it, so the loop stays short.
  const earliestAllowed = toDateString(addDays(parseDate(last), -7 * (MAX_WEEKLY_STATS_WEEKS - 1)));
  if (first < earliestAllowed) first = earliestAllowed;

  // Compares Dates, not strings: past year 9999 toISOString() gives
  // "+010000-...", which sorts before "9999-..." as text and never ends.
  const lastDate = parseDate(last);
  const weeks = [];
  for (let d = parseDate(first); d <= lastDate; d = addDays(d, 7)) {
    const weekStart = toDateString(d);
    weeks.push(byWeek.get(weekStart) || { weekStart, reviewed: 0, skipped: 0 });
  }
  return weeks;
}

const MAX_WEEKLY_STATS_WEEKS = 520;

function mondayOf(date) {
  const day = parseDate(date.toISOString().slice(0, 10));
  const mondayOffset = (day.getUTCDay() + 6) % 7; // 0=Mon .. 6=Sun
  return toDateString(addDays(day, -mondayOffset));
}

// All-time, like getCurrentStreak -- a stats dashboard that reset every
// January 1st would be wrong for the same reason a streak would be.
async function getWeeklyStats(userId, today) {
  const grouped = await prisma.review.groupBy({
    by: ['date', 'result'],
    where: { item: { userId, deletedAt: null } },
    _count: true,
  });
  return deriveWeeklyStats(grouped, today);
}

async function getItemCountsByMode(userId) {
  const rows = await prisma.item.groupBy({
    by: ['mode'],
    where: { userId, deletedAt: null },
    _count: true,
  });
  const counts = { FIXED: 0, ADAPTIVE: 0 };
  for (const row of rows) counts[row.mode] = row._count;
  return counts;
}

// Grades are the one Adaptive-only number that means exactly what it says --
// no denominator problem, no age confound (unlike a reviewed/skipped split
// by mode would have, since Fixed items in this dataset are always older
// than Adaptive ones). Fixed reviews have no grade at all, so there's no
// honest way to put them on the same axis -- this stays Adaptive-only.
async function getAdaptiveGradeDistribution(userId) {
  const rows = await prisma.review.groupBy({
    by: ['grade'],
    where: { item: { userId, deletedAt: null, mode: 'ADAPTIVE' }, grade: { not: null } },
    _count: true,
  });
  const counts = { AGAIN: 0, HARD: 0, GOOD: 0, EASY: 0 };
  for (const row of rows) counts[row.grade] = row._count;
  return counts;
}

async function getStats(userId, today) {
  const [weekly, itemsByMode, adaptiveGrades] = await Promise.all([
    getWeeklyStats(userId, today),
    getItemCountsByMode(userId),
    getAdaptiveGradeDistribution(userId),
  ]);
  return { weekly, itemsByMode, adaptiveGrades };
}

module.exports = {
  createItem,
  listItems,
  getItemById,
  updateItemText,
  softDeleteItem,
  listDueItems,
  reviewItem,
  getRetrievabilityCurve,
  skipItem,
  resetItem,
  switchItemMode,
  getReviewHistory,
  deriveReviewHistory,
  getCurrentStreak,
  deriveStreak,
  deriveWeeklyStats,
  getStats,
};
