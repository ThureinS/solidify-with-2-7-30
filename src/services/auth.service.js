const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { signToken } = require('../lib/jwt');
const emailQueue = require('../lib/emailQueue');

const SALT_ROUNDS = 10;

// Feature flag: a kill switch for the welcome email, toggleable without a
// redeploy (e.g. if Gmail starts rate-limiting/blocking the SMTP account).
// Defaults on -- only "false" turns it off.
const WELCOME_EMAIL_ENABLED = process.env.FEATURE_WELCOME_EMAIL !== 'false';

async function registerUser({ email, password }) {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  // Fire-and-forget: never awaited inline, so a queue/Redis failure can't
  // turn a successful signup into a 500.
  if (emailQueue && WELCOME_EMAIL_ENABLED) {
    emailQueue
      .add('welcome', { userId: user.id, email: user.email })
      .catch((err) => console.error('enqueue welcome failed:', err.message));
  }

  return user;
}

async function loginUser({ email, password }) {
  const user = await prisma.user.findUnique({ where: { email } });

  // Same message whether the email doesn't exist or the password is wrong --
  // telling them apart would confirm which emails are registered.
  const invalidCredentials = () =>
    new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

  if (!user) throw invalidCredentials();

  const passwordMatches = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatches) throw invalidCredentials();

  if (user.isSuspended) {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended');
  }

  return signToken({ userId: user.id, role: user.role, tokenVersion: user.tokenVersion });
}

// Bumps tokenVersion so every other token this user has out there (other
// tabs, other devices) fails requireAuth's version check on its next request.
// The token used to make *this* request would fail that same check, so we
// sign and return a fresh one in the same response.
async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordMatches) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }

  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { passwordHash, tokenVersion: { increment: 1 } },
  });

  return signToken({ userId: updated.id, role: updated.role, tokenVersion: updated.tokenVersion });
}

module.exports = { registerUser, loginUser, changePassword };
