const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { revokeAllRefreshTokensForUser } = require('./auth.service');

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

  // requireAuth already blocks a suspended user's existing access token on
  // its next request; this closes the matching hole on the refresh-token
  // side so a suspended user can't mint a fresh one via /auth/refresh either.
  if (isSuspended) await revokeAllRefreshTokensForUser(targetId);
}

module.exports = { listUsers, setSuspended };
