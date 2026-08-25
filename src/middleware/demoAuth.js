const prisma = require('../lib/prisma');
const { AppError } = require('./errorHandler');
const { DEMO_ACCOUNT_EMAIL } = require('../lib/demoAccount');

// Unauthenticated by design (ADR 0004): no Authorization header is read or
// required. Every request that reaches this middleware resolves to the same
// fixed seeded account, regardless of what (if anything) the client sends.
async function demoAuth(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { email: DEMO_ACCOUNT_EMAIL } });
    if (!user) {
      throw new AppError(503, 'DEMO_NOT_SEEDED', 'The demo account has not been seeded on this environment');
    }
    req.userId = user.id;
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = demoAuth;
