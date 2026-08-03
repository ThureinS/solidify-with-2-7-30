import { describe, it, expect, vi, beforeEach } from 'vitest';

// Needed for real: auth.service.js calls the real signToken, which reads this
// at call time. A vi.mock of jwt.js wouldn't reach auth.service.js's already-
// destructured `signToken` reference anyway (see below), so a real secret is
// simpler than trying to fake it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-refresh-token-tests';

import prisma from '../src/lib/prisma.js';
import { refresh } from '../src/services/auth.service.js';

// vi.mock() doesn't reach this: auth.service.js requires prisma.js via a
// plain nested CJS require, which Vitest's module-graph mocking doesn't
// intercept in this "type": "commonjs" project. Spying directly on the real
// client's methods works instead, because `prisma.refreshToken` is the exact
// same object instance auth.service.js reads on every call -- no module
// interception needed, just shared object identity.
const activeUser = { id: 'user-1', role: 'USER', tokenVersion: 0, isSuspended: false };

function tokenRow(overrides = {}) {
  return {
    id: 'row-1',
    userId: 'user-1',
    familyId: 'family-1',
    revokedAt: null,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1h from now
    ...overrides,
  };
}

beforeEach(() => {
  // Restore before re-spying, or each test's mock.calls history (and any
  // leftover resolved value) would carry over from the previous test.
  vi.restoreAllMocks();
  vi.spyOn(prisma.refreshToken, 'findUnique').mockResolvedValue(null);
  vi.spyOn(prisma.refreshToken, 'update').mockResolvedValue({});
  vi.spyOn(prisma.refreshToken, 'updateMany').mockResolvedValue({ count: 0 });
  vi.spyOn(prisma.refreshToken, 'create').mockResolvedValue({});
  vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(activeUser);
});

describe('auth.service.refresh', () => {
  it('rotates: revokes the presented token and issues a new one in the same family', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(tokenRow());

    const result = await refresh('some-raw-token');

    expect(typeof result.accessToken).toBe('string');
    expect(typeof result.refreshToken).toBe('string');

    expect(prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'row-1' },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ familyId: 'family-1' }) }),
    );
  });

  it('detects reuse of an already-rotated token and kills the whole family', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(tokenRow({ revokedAt: new Date() }));

    await expect(refresh('already-used-token')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects an expired token without touching the rest of the family', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(
      tokenRow({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(refresh('expired-token')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });

    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects a valid token for a suspended user', async () => {
    prisma.refreshToken.findUnique.mockResolvedValue(tokenRow());
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, isSuspended: true });

    await expect(refresh('some-raw-token')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });

    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    await expect(refresh('never-issued')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });
  });
});
