const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { parseDate, addDays } = require('../lib/dates');

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

module.exports = { createItem, listItems, getItemById, updateItemText, softDeleteItem };
