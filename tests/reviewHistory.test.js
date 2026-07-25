import { describe, it, expect } from 'vitest';
import { deriveReviewHistory } from '../src/services/items.service.js';
import { parseDate } from '../src/lib/dates.js';

function row(date, result, count) {
  return { date: parseDate(date), result, _count: count };
}

describe('deriveReviewHistory', () => {
  it('marks a reviewed-only day as full', () => {
    const days = deriveReviewHistory([row('2026-01-03', 'REVIEWED', 2)]);
    expect(days).toEqual([{ date: '2026-01-03', reviewCount: 2, skipCount: 0, state: 'full' }]);
  });

  it('marks a day with both reviews and skips as half', () => {
    const days = deriveReviewHistory([
      row('2026-01-05', 'REVIEWED', 1),
      row('2026-01-05', 'SKIPPED', 1),
    ]);
    expect(days).toEqual([{ date: '2026-01-05', reviewCount: 1, skipCount: 1, state: 'half' }]);
  });

  it('marks a skip-only day as half, not full or absent', () => {
    const days = deriveReviewHistory([row('2026-01-07', 'SKIPPED', 3)]);
    expect(days).toEqual([{ date: '2026-01-07', reviewCount: 0, skipCount: 3, state: 'half' }]);
  });

  it('leaves days with no rows out of the response entirely', () => {
    const days = deriveReviewHistory([row('2026-01-03', 'REVIEWED', 1)]);
    expect(days).toHaveLength(1);
    expect(days.some((d) => d.date === '2026-01-04')).toBe(false);
  });

  it('sorts results by date', () => {
    const days = deriveReviewHistory([
      row('2026-03-01', 'REVIEWED', 1),
      row('2026-01-01', 'REVIEWED', 1),
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-01-01', '2026-03-01']);
  });
});
