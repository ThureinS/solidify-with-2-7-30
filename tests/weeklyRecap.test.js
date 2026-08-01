import { describe, it, expect } from 'vitest';
import { computeWeeklyRecap } from '../frontend/src/weeklyRecap.js';

// Helper: one entry per date, `n` actions on that day.
const day = (date, n) => ({ date, reviewCount: n, skipCount: 0 });

// 2026-08-01 is a Saturday, so this week is Mon 2026-07-27 .. Sat 2026-08-01
// and the comparable slice of last week is Mon 2026-07-20 .. Sat 2026-07-25.
describe('computeWeeklyRecap', () => {
  it('compares the same slice of both weeks, not a partial week against a whole one', () => {
    const days = [
      day('2026-07-20', 5), // last week, in the comparable slice
      day('2026-07-26', 9), // last week SUNDAY -- after today's weekday, must be excluded
      day('2026-07-27', 3), // this week
    ];
    const recap = computeWeeklyRecap(days, '2026-08-01');
    expect(recap.thisWeekCount).toBe(3);
    expect(recap.lastWeekCount).toBe(5); // 9 would mean the old whole-week bug is back
    expect(recap.verb).toBe('down from');
  });

  it('compares Monday against Monday when today is a Monday', () => {
    const days = [
      day('2026-07-20', 4), // the Monday one week before
      day('2026-07-21', 8), // the Tuesday after it -- outside the slice
      day('2026-07-27', 6), // today
    ];
    const recap = computeWeeklyRecap(days, '2026-07-27');
    expect(recap.thisWeekCount).toBe(6);
    expect(recap.lastWeekCount).toBe(4);
    expect(recap.verb).toBe('up from');
  });

  it('treats Sunday as the last day of the week, not the first', () => {
    // 2026-08-02 is a Sunday: this week is Mon 07-27..Sun 08-02, a full week.
    const days = [day('2026-07-27', 1), day('2026-08-02', 1), day('2026-08-03', 99)];
    const recap = computeWeeklyRecap(days, '2026-08-02');
    expect(recap.thisWeekCount).toBe(2); // 08-03 is next Monday, excluded
  });

  it('counts skips as handled -- the recap measures showing up, like the streak', () => {
    const days = [{ date: '2026-07-27', reviewCount: 1, skipCount: 2 }];
    expect(computeWeeklyRecap(days, '2026-08-01').thisWeekCount).toBe(3);
  });

  it('returns null when there is nothing in either week to compare', () => {
    expect(computeWeeklyRecap([day('2026-01-05', 4)], '2026-08-01')).toBe(null);
  });
});
