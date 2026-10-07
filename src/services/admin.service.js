const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { revokeAllRefreshTokensForUser } = require('./auth.service');
const { DEMO_ACCOUNT_EMAIL } = require('../lib/demoAccount');

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
  // The public demo (ADR 0004) is shown to visitors and instructors; an admin
  // click must never lock it. The admin UI hides the button too, but only this
  // check stops a direct API call.
  if (isSuspended) {
    const target = await prisma.user.findUnique({ where: { id: targetId }, select: { email: true } });
    if (target?.email === DEMO_ACCOUNT_EMAIL) {
      throw new AppError(403, 'CANNOT_SUSPEND_DEMO', 'The demo account cannot be suspended');
    }
  }

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
