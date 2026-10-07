import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../src/lib/prisma.js';
import { setSuspended } from '../src/services/admin.service.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/lib/demoAccount.js';

// Same approach as refreshToken.test.js: spy on the shared prisma client
// instead of vi.mock, which can't reach the service's nested CJS require.
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(prisma.user, 'findUnique').mockResolvedValue({ email: 'real-user@example.com' });
  vi.spyOn(prisma.user, 'updateMany').mockResolvedValue({ count: 1 });
  vi.spyOn(prisma.refreshToken, 'updateMany').mockResolvedValue({ count: 0 });
});

describe('admin.service.setSuspended', () => {
  it('refuses to suspend the demo account and changes nothing', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: DEMO_ACCOUNT_EMAIL });

    await expect(setSuspended('demo-id', true)).rejects.toMatchObject({
      status: 403,
      code: 'CANNOT_SUSPEND_DEMO',
    });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('suspends a normal user and revokes their refresh tokens', async () => {
    await setSuspended('user-1', true);

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { isSuspended: true },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
  });

  it('still allows unsuspending the demo account (a safe recovery path)', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: DEMO_ACCOUNT_EMAIL });

    await setSuspended('demo-id', false);

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'demo-id' },
      data: { isSuspended: false },
    });
  });

  it('returns 404 for an unknown user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(setSuspended('missing', true)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
