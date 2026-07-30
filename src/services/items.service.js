const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { parseDate, addDays, toDateString } = require('../lib/dates');
const schedule = require('./schedule.service');

const FIRST_REVIEW_OFFSET_DAYS = 2;

async function createItem(userId, { text, date }) {
  const dateAdded = parseDate(date);
  const nextReviewDate = addDays(dateAdded, FIRST_REVIEW_OFFSET_DAYS);
  return prisma.item.create({
    data: { userId, text, dateAdded, nextReviewDate, stage: 0 },
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

async function reviewItem(userId, id, date) {
  const item = await findOwnedItem(userId, id);
  const nextState = schedule.applyReview(item, date); // throws AppError if not allowed

  await prisma.$transaction([
    prisma.review.create({ data: { itemId: id, date: parseDate(date), result: 'REVIEWED' } }),
    prisma.item.update({ where: { id }, data: nextState }),
  ]);
  return getItemById(userId, id);
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

module.exports = {
  createItem,
  listItems,
  getItemById,
  updateItemText,
  softDeleteItem,
  listDueItems,
  reviewItem,
  skipItem,
  getReviewHistory,
  deriveReviewHistory,
  getCurrentStreak,
  deriveStreak,
};
