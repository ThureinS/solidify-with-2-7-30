const bcrypt = require('bcrypt');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');
const { signToken } = require('../lib/jwt');
const emailQueue = require('../lib/emailQueue');

const SALT_ROUNDS = 10;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days -- see developer-handover.md §12b

// Feature flag: a kill switch for the welcome email, toggleable without a
// redeploy (e.g. if Gmail starts rate-limiting/blocking the SMTP account).
// Defaults on -- only "false" turns it off.
const WELCOME_EMAIL_ENABLED = process.env.FEATURE_WELCOME_EMAIL !== 'false';

function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// One row per token ever issued. `familyId` links every token descended from
// the same login, so rotation and reuse-detection can act on "this session's
// whole chain" rather than one row at a time.
async function issueTokenPair({ userId, role, tokenVersion, familyId }) {
  const accessToken = signToken({ userId, role, tokenVersion });
  const refreshToken = crypto.randomBytes(32).toString('base64url');

  await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });

  return { accessToken, refreshToken };
}

// Suspend already revokes access instantly (requireAuth re-checks isSuspended
// per request); this additionally kills any refresh tokens so a suspended
// user can't mint fresh access tokens via /auth/refresh either.
async function revokeAllRefreshTokensForUser(userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

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

  return issueTokenPair({
    userId: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion,
    familyId: crypto.randomUUID(),
  });
}

// Rotation + reuse detection: the presented token is always revoked as part
// of issuing the next pair, so a *second* presentation of the same token can
// only mean it was copied by someone else -- treat that as the family being
// compromised and kill every token descended from the same login.
async function refresh(rawRefreshToken) {
  const invalidToken = () =>
    new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token');

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawRefreshToken) },
  });
  if (!stored) throw invalidToken();

  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw invalidToken();
  }

  if (stored.expiresAt < new Date()) throw invalidToken();

  const user = await prisma.user.findUnique({ where: { id: stored.userId } });
  if (!user || user.isSuspended) throw invalidToken();

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });

  return issueTokenPair({
    userId: user.id,
    role: user.role,
    tokenVersion: user.tokenVersion,
    familyId: stored.familyId,
  });
}

// Idempotent: a token that's missing or already revoked just means there's
// nothing left to do, not an error -- logging out twice should never fail.
async function logout(rawRefreshToken) {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(rawRefreshToken) },
  });
  if (!stored) return;

  await prisma.refreshToken.updateMany({
    where: { familyId: stored.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Bumps tokenVersion so every other access token this user has out there
// (other tabs, other devices) fails requireAuth's version check on its next
// request. Refresh tokens aren't covered by tokenVersion at all (they're
// looked up in Postgres, not verified as JWTs), so without the explicit
// revoke here a stolen-but-unused refresh token would survive a password
// change and keep minting valid access tokens forever -- the same "ends
// other sessions" guarantee this column already gives access tokens.
async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const passwordMatches = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!passwordMatches) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }

  // Atomic: unlike suspend (where requireAuth/refresh both also re-check
  // isSuspended directly), tokenVersion is the *only* thing access tokens
  // check, and refresh tokens don't check tokenVersion at all -- the revoke
  // below is the only thing stopping a stolen refresh token from surviving
  // a password change. A process crash between two separate statements here
  // would leave that revoke undone with the password already changed.
  const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash, tokenVersion: { increment: 1 } },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  return issueTokenPair({
    userId: updated.id,
    role: updated.role,
    tokenVersion: updated.tokenVersion,
    familyId: crypto.randomUUID(),
  });
}

module.exports = {
  registerUser,
  loginUser,
  changePassword,
  refresh,
  logout,
  revokeAllRefreshTokensForUser,
};
