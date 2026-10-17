import { describe, it, expect } from 'vitest';
import { buildFixture } from '../scripts/seedFixture.js';
import {
  adaptiveStartOfLife,
  applyReview,
  applySkip,
  fixedStartOfLife,
  isDueOn,
} from '../src/services/schedule.service.js';
import { deriveReviewHistory } from '../src/services/items.service.js';
import { addDays, daysBetween, parseDate, toDateString } from '../src/lib/dates.js';

// Fixed seed days, not "now": the fixture is relative to its seed day, and
// these three probe a mid-month Saturday, a day right after New Year (where
// the ~13-month-old items land two calendar years back) and a leap day.
const SEED_DAYS = ['2026-10-17', '2027-01-02', '2028-02-29'];

// Replays an item's review rows through the same functions production uses,
// starting from its mode's start-of-life state. An impossible history (an
// early review, a row after archiving) throws here -- that is the point.
function replay(item) {
  let state =
    item.state.mode === 'ADAPTIVE'
      ? adaptiveStartOfLife(toDateString(item.dateAdded))
      : fixedStartOfLife(toDateString(item.dateAdded), item.state.finalIntervalDays);
  for (const row of [...item.reviews].sort((a, b) => a.date - b.date)) {
    const delta =
      row.result === 'SKIPPED'
        ? applySkip(state, toDateString(row.date))
        : applyReview(state, toDateString(row.date), row.grade);
    state = { ...state, ...delta };
  }
  return state;
}

function plain(state) {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, value instanceof Date ? toDateString(value) : value])
  );
}

describe.each(SEED_DAYS)('buildFixture on %s', (seedDay) => {
  const today = parseDate(seedDay);
  const items = buildFixture(today);

  it('is deterministic', () => {
    expect(JSON.stringify(buildFixture(parseDate(seedDay)))).toBe(JSON.stringify(items));
  });

  it('has no review row before its item was added, and none in the future', () => {
    for (const item of items) {
      for (const row of item.reviews) {
        expect(row.date >= item.dateAdded).toBe(true);
        expect(row.date <= today).toBe(true);
      }
    }
  });

  it('never records a review and a skip for the same item on the same day', () => {
    for (const item of items) {
      const seen = new Set();
      for (const row of item.reviews) {
        const key = toDateString(row.date);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("replays every item's rows from start-of-life into exactly its declared state", () => {
    for (const item of items) {
      expect(plain(replay(item))).toEqual(plain(item.state));
    }
  });

  it('leaves every item still due today without a row today', () => {
    for (const item of items) {
      if (!isDueOn(item.state, seedDay)) continue;
      expect(item.reviews.some((row) => toDateString(row.date) === seedDay)).toBe(false);
    }
  });

  it('leaves a demo-ready due list: several items due, exactly one 5 days overdue, never touched', () => {
    const due = items.filter((item) => isDueOn(item.state, seedDay));
    expect(due.length).toBeGreaterThanOrEqual(4);

    const overdue = due.filter((item) => daysBetween(item.state.nextReviewDate, today) === 5);
    expect(overdue).toHaveLength(1);
    expect(overdue[0].reviews).toHaveLength(0);
  });

  it('keeps activity in both the current and the previous calendar year for the year switcher', () => {
    const years = new Set(items.flatMap((item) => item.reviews.map((row) => toDateString(row.date).slice(0, 4))));
    expect(years.has(String(today.getUTCFullYear()))).toBe(true);
    expect(years.has(String(today.getUTCFullYear() - 1))).toBe(true);
  });

  it('gives the History page full, half and empty states within the last three weeks', () => {
    // Feed the fixture's rows through the real deriveReviewHistory, grouped
    // the way Prisma's groupBy returns them.
    const grouped = new Map();
    for (const item of items) {
      for (const row of item.reviews) {
        const key = `${toDateString(row.date)}|${row.result}`;
        grouped.set(key, (grouped.get(key) ?? 0) + 1);
      }
    }
    const days = deriveReviewHistory(
      [...grouped.entries()].map(([key, count]) => {
        const [date, result] = key.split('|');
        return { date: parseDate(date), result, _count: count };
      })
    );
    // Exactly the 21 days before the seed day.
    const windowStart = toDateString(addDays(today, -21));
    const inWindow = days.filter((day) => day.date >= windowStart && day.date < seedDay);
    const activeDays = new Set(inWindow.map((day) => day.date));

    expect(inWindow.some((day) => day.state === 'full')).toBe(true);
    expect(inWindow.some((day) => day.state === 'half')).toBe(true);
    // 21-day window minus the active days -- at least one day with nothing logged.
    expect(21 - activeDays.size).toBeGreaterThan(0);
  });
});
