import { describe, it, expect } from 'vitest';
import { deriveWeeklyStats } from '../src/services/items.service.js';
import { parseDate } from '../src/lib/dates.js';

function row(date, result, count) {
  return { date: parseDate(date), result, _count: count };
}

describe('deriveWeeklyStats', () => {
  it('buckets a single day under its week\'s Monday', () => {
    // 2026-01-07 is a Wednesday -- that week's Monday is 2026-01-05.
    const weeks = deriveWeeklyStats([row('2026-01-07', 'REVIEWED', 3)]);
    expect(weeks).toEqual([{ weekStart: '2026-01-05', reviewed: 3, skipped: 0 }]);
  });

  it('keeps a Sunday in the same week as the Monday before it', () => {
    // 2026-01-04 is a Sunday, belongs to the week starting 2025-12-29.
    const weeks = deriveWeeklyStats([
      row('2025-12-29', 'REVIEWED', 1), // Monday
      row('2026-01-04', 'REVIEWED', 1), // Sunday, same week
    ]);
    expect(weeks).toEqual([{ weekStart: '2025-12-29', reviewed: 2, skipped: 0 }]);
  });

  it('splits a Monday into a new week from the Sunday just before it', () => {
    const weeks = deriveWeeklyStats([
      row('2026-01-04', 'REVIEWED', 1), // Sunday, week of 2025-12-29
      row('2026-01-05', 'REVIEWED', 1), // Monday, new week
    ]);
    expect(weeks).toEqual([
      { weekStart: '2025-12-29', reviewed: 1, skipped: 0 },
      { weekStart: '2026-01-05', reviewed: 1, skipped: 0 },
    ]);
  });

  it('sums reviewed and skipped separately, never as a ratio', () => {
    const weeks = deriveWeeklyStats([
      row('2026-01-05', 'REVIEWED', 4),
      row('2026-01-06', 'SKIPPED', 2),
    ]);
    expect(weeks).toEqual([{ weekStart: '2026-01-05', reviewed: 4, skipped: 2 }]);
  });

  it('sorts weeks ascending', () => {
    const weeks = deriveWeeklyStats([
      row('2026-03-02', 'REVIEWED', 1),
      row('2026-01-05', 'REVIEWED', 1),
    ]);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-01-05', '2026-03-02']);
  });
});
