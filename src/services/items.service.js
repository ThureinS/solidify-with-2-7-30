const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { parseDate, addDays } = require('../lib/dates');
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
};
