import { describe, it, expect } from 'vitest';
import { deriveWeeklyStats } from '../src/services/items.service.js';
import { statsQuerySchema } from '../src/dto/item.schemas.js';
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
      row('2026-01-19', 'REVIEWED', 1),
      row('2026-01-05', 'REVIEWED', 1),
    ]);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
  });
});

describe('deriveWeeklyStats empty weeks', () => {
  it('fills a week with no activity as 0/0 instead of leaving it out', () => {
    const weeks = deriveWeeklyStats([
      row('2026-01-05', 'REVIEWED', 2),
      row('2026-01-19', 'SKIPPED', 1),
    ]);
    expect(weeks).toEqual([
      { weekStart: '2026-01-05', reviewed: 2, skipped: 0 },
      { weekStart: '2026-01-12', reviewed: 0, skipped: 0 },
      { weekStart: '2026-01-19', reviewed: 0, skipped: 1 },
    ]);
  });

  it('shows a 9-month gap as ~39 weeks, not as one step', () => {
    const weeks = deriveWeeklyStats([
      row('2025-08-04', 'REVIEWED', 1),
      row('2026-05-04', 'REVIEWED', 1),
    ]);
    expect(weeks).toHaveLength(40);
    expect(weeks.slice(1, -1).every((w) => w.reviewed === 0 && w.skipped === 0)).toBe(true);
  });

  it('extends zero weeks up to the week of the client-provided today', () => {
    // 2026-01-22 is a Thursday, in the week starting 2026-01-19.
    const weeks = deriveWeeklyStats([row('2026-01-05', 'REVIEWED', 3)], '2026-01-22');
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19']);
    expect(weeks[2]).toEqual({ weekStart: '2026-01-19', reviewed: 0, skipped: 0 });
  });

  it('without today, stops at the last active week (no server-clock guess)', () => {
    const weeks = deriveWeeklyStats([row('2026-01-05', 'REVIEWED', 3)]);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-01-05']);
  });

  it('never hides real weeks when today is earlier than the last review', () => {
    const weeks = deriveWeeklyStats(
      [row('2026-01-05', 'REVIEWED', 1), row('2026-01-12', 'REVIEWED', 1)],
      '2025-12-01'
    );
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-01-05', '2026-01-12']);
  });

  it('returns [] for an account with no reviews, even with today', () => {
    expect(deriveWeeklyStats([], '2026-01-22')).toEqual([]);
  });

  it('caps a far-future today at the 520 most recent weeks', () => {
    const weeks = deriveWeeklyStats([row('2026-01-05', 'REVIEWED', 1)], '9999-12-31');
    expect(weeks).toHaveLength(520);
    expect(weeks.at(-1).weekStart).toBe('9999-12-27');
  });
});

describe('statsQuerySchema', () => {
  it('accepts no date at all (older callers keep working)', () => {
    expect(statsQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts a real calendar date', () => {
    expect(statsQuerySchema.safeParse({ date: '2026-02-28' }).success).toBe(true);
  });

  it.each(['2026-13-45', '2026-02-30', '26-01-05', 'today'])('rejects %s', (date) => {
    expect(statsQuerySchema.safeParse({ date }).success).toBe(false);
  });
});
