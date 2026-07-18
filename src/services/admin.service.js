const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

async function listUsers({ page, limit }) {
  const [users, total] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count(),
  ]);
  return { users, total };
}

async function setSuspended(targetId, isSuspended) {
  const { count } = await prisma.user.updateMany({
    where: { id: targetId },
    data: { isSuspended },
  });
  if (count === 0) throw new AppError(404, 'NOT_FOUND', 'User not found');
}

module.exports = { listUsers, setSuspended };
