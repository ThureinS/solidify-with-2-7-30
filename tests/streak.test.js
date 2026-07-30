import { describe, it, expect } from 'vitest';
import { deriveStreak } from '../src/services/items.service.js';

describe('deriveStreak', () => {
  it('is 0 with no activity at all', () => {
    expect(deriveStreak([], '2026-01-10')).toBe(0);
  });

  it('counts back from today when today is active', () => {
    const dates = ['2026-01-08', '2026-01-09', '2026-01-10'];
    expect(deriveStreak(dates, '2026-01-10')).toBe(3);
  });

  it('counts back from yesterday when today has no activity yet', () => {
    const dates = ['2026-01-08', '2026-01-09'];
    expect(deriveStreak(dates, '2026-01-10')).toBe(2);
  });

  it('stops at the first gap', () => {
    const dates = ['2026-01-05', '2026-01-08', '2026-01-09', '2026-01-10'];
    expect(deriveStreak(dates, '2026-01-10')).toBe(3);
  });

  it('is 0 once a full day has passed with no activity', () => {
    const dates = ['2026-01-08'];
    expect(deriveStreak(dates, '2026-01-10')).toBe(0);
  });

  it('crosses a year boundary without resetting', () => {
    const dates = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'];
    expect(deriveStreak(dates, '2026-01-02')).toBe(4);
  });
});
