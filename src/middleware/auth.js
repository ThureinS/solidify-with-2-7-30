const { verifyToken } = require('../lib/jwt');
const prisma = require('../lib/prisma');
const { AppError } = require('./errorHandler');

// Verifies the bearer token and re-checks the user's current suspension
// status on every request (a stateless JWT can't know about a suspension
// that happened after it was signed -- only the database knows that).
async function requireAuth(req, res, next) {
  try {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Missing or malformed Authorization header');
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token');
    }
    if (user.isSuspended) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended');
    }

    req.userId = user.id;
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireAuth;
