const prisma = require('../lib/prisma');

async function exportUserData(userId, includeDeleted) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const items = await prisma.item.findMany({
    where: { userId, ...(includeDeleted ? {} : { deletedAt: null }) },
    orderBy: { dateAdded: 'asc' },
    include: { reviews: { orderBy: { date: 'asc' } } },
  });

  return { user, items };
}

module.exports = { exportUserData };
