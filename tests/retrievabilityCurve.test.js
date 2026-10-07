import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../src/lib/prisma.js';
import { getRetrievabilityCurve } from '../src/services/items.service.js';

// Same approach as adminSuspend.test.js: spy on the shared prisma client.
function mockItem(fields) {
  vi.spyOn(prisma.item, 'findFirst').mockResolvedValue({ id: 'item-1', reviews: [], ...fields });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// The item page asks for the curve at the same time as the item (U19), so it
// doesn't know the mode yet. "No curve" must be a normal answer, not an error.
describe('items.service.getRetrievabilityCurve', () => {
  it('returns no points for a Fixed item', async () => {
    mockItem({ mode: 'FIXED', stability: null });

    await expect(getRetrievabilityCurve('user-1', 'item-1', '2026-10-07')).resolves.toEqual({ points: [] });
  });

  it('returns no points for an Adaptive item with no review yet', async () => {
    mockItem({ mode: 'ADAPTIVE', stability: null });

    await expect(getRetrievabilityCurve('user-1', 'item-1', '2026-10-07')).resolves.toEqual({ points: [] });
  });

  it('returns the curve and today point for a reviewed Adaptive item', async () => {
    mockItem({ mode: 'ADAPTIVE', stability: 10, lastReviewDate: new Date('2026-10-01T00:00:00Z') });

    const curve = await getRetrievabilityCurve('user-1', 'item-1', '2026-10-07');

    expect(curve.points.length).toBeGreaterThan(0);
    expect(curve.today.day).toBe(6);
  });

  it('still answers 404 for an item that is missing or deleted', async () => {
    vi.spyOn(prisma.item, 'findFirst').mockResolvedValue(null);

    await expect(getRetrievabilityCurve('user-1', 'item-1', '2026-10-07')).rejects.toMatchObject({ status: 404 });
  });
});
