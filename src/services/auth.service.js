const bcrypt = require('bcrypt');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { signToken } = require('../lib/jwt');
const emailQueue = require('../lib/emailQueue');

const SALT_ROUNDS = 10;

async function registerUser({ email, password }) {
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await prisma.user.create({ data: { email, passwordHash } });

  // Fire-and-forget: never awaited inline, so a queue/Redis failure can't
  // turn a successful signup into a 500.
  if (emailQueue) {
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

  return signToken({ userId: user.id, role: user.role });
}

module.exports = { registerUser, loginUser };
