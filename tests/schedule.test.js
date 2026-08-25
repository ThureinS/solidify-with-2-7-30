import { describe, it, expect } from 'vitest';
import {
  isDueOn,
  applyReview,
  applySkip,
  fixedStartOfLife,
  adaptiveStartOfLife,
} from '../src/services/schedule.service.js';
import * as fsrs from '../src/services/fsrs.service.js';
import { parseDate, addDays } from '../src/lib/dates.js';

function makeItem({ mode = 'FIXED', stage = 0, nextReviewDate, isComplete = false, finalIntervalDays = 30 }) {
  return { mode, stage, nextReviewDate: parseDate(nextReviewDate), isComplete, finalIntervalDays };
}

function makeAdaptiveItem({ nextReviewDate, difficulty = null, stability = null, lastReviewDate = null }) {
  return {
    mode: 'ADAPTIVE',
    isComplete: false,
    nextReviewDate: parseDate(nextReviewDate),
    difficulty,
    stability,
    lastReviewDate: lastReviewDate ? parseDate(lastReviewDate) : null,
  };
}

describe('isDueOn', () => {
  it('is due when nextReviewDate is exactly today', () => {
    expect(isDueOn(makeItem({ nextReviewDate: '2026-07-20' }), '2026-07-20')).toBe(true);
  });

  it('is due when overdue (nextReviewDate before today)', () => {
    expect(isDueOn(makeItem({ nextReviewDate: '2026-07-18' }), '2026-07-20')).toBe(true);
  });

  it('is not due when nextReviewDate is in the future', () => {
    expect(isDueOn(makeItem({ nextReviewDate: '2026-07-22' }), '2026-07-20')).toBe(false);
  });

  it('is never due once the item is complete, even if the date matches', () => {
    expect(isDueOn(makeItem({ nextReviewDate: '2026-07-18', isComplete: true }), '2026-07-20')).toBe(false);
  });
});

describe('applyReview', () => {
  it('advances stage 0 -> 1, next review = completion date + 7', () => {
    const item = makeItem({ stage: 0, nextReviewDate: '2026-07-20' });
    const result = applyReview(item, '2026-07-20');
    expect(result).toEqual({ stage: 1, nextReviewDate: parseDate('2026-07-27'), isComplete: false });
  });

  it('advances stage 1 -> 2, next review = completion date + 30', () => {
    const item = makeItem({ stage: 1, nextReviewDate: '2026-07-20' });
    const result = applyReview(item, '2026-07-20');
    expect(result).toEqual({ stage: 2, nextReviewDate: parseDate('2026-08-19'), isComplete: false });
  });

  it('archives the item once the stage-2 review is done', () => {
    const item = makeItem({ stage: 2, nextReviewDate: '2026-07-20' });
    const result = applyReview(item, '2026-07-20');
    expect(result.isComplete).toBe(true);
  });

  it('counts intervals from the completion date, not from when it was originally due', () => {
    const item = makeItem({ stage: 0, nextReviewDate: '2026-07-15' }); // overdue, reviewed late
    const result = applyReview(item, '2026-07-20');
    expect(result.nextReviewDate).toEqual(parseDate('2026-07-27')); // +7 from the 20th, not the 15th
  });

  it('rejects an early review attempt', () => {
    const item = makeItem({ stage: 0, nextReviewDate: '2026-07-22' });
    expect(() => applyReview(item, '2026-07-20')).toThrow(
      expect.objectContaining({ status: 409, code: 'ITEM_NOT_DUE' }),
    );
  });

  it('rejects a review on an already-archived item', () => {
    const item = makeItem({ stage: 2, nextReviewDate: '2026-07-18', isComplete: true });
    expect(() => applyReview(item, '2026-07-20')).toThrow(
      expect.objectContaining({ status: 409, code: 'ITEM_ARCHIVED' }),
    );
  });

  it('rejects a duplicate review the same day (double-click protection)', () => {
    const item = makeItem({ stage: 0, nextReviewDate: '2026-07-20' });
    const afterFirstReview = applyReview(item, '2026-07-20');
    const updatedItem = { ...item, ...afterFirstReview };
    expect(() => applyReview(updatedItem, '2026-07-20')).toThrow(
      expect.objectContaining({ status: 409, code: 'ITEM_NOT_DUE' }),
    );
  });
});

describe('applySkip', () => {
  it('pushes nextReviewDate one day forward and leaves stage untouched', () => {
    const item = makeItem({ stage: 1, nextReviewDate: '2026-07-20' });
    const result = applySkip(item, '2026-07-20');
    expect(result).toEqual({ nextReviewDate: parseDate('2026-07-21') });
  });

  it('rejects skipping an item that is not due yet', () => {
    const item = makeItem({ stage: 0, nextReviewDate: '2026-07-25' });
    expect(() => applySkip(item, '2026-07-20')).toThrow(
      expect.objectContaining({ status: 409, code: 'ITEM_NOT_DUE' }),
    );
  });

  it('rejects skipping an already-archived item', () => {
    const item = makeItem({ stage: 2, nextReviewDate: '2026-07-18', isComplete: true });
    expect(() => applySkip(item, '2026-07-20')).toThrow(
      expect.objectContaining({ status: 409, code: 'ITEM_ARCHIVED' }),
    );
  });

  it('does not touch FSRS state on an Adaptive item -- only nextReviewDate moves', () => {
    const item = makeAdaptiveItem({ nextReviewDate: '2026-07-20', difficulty: 5, stability: 10, lastReviewDate: '2026-07-10' });
    const result = applySkip(item, '2026-07-20');
    // toEqual fails if this had leaked extra keys (e.g. a bumped lastReviewDate).
    expect(result).toEqual({ nextReviewDate: parseDate('2026-07-21') });

    // Confirm lastReviewDate is still '2026-07-10' (not silently bumped to
    // the skip date) by cross-checking the post-skip review against a
    // manual FSRS calculation using that exact 11-day span (07-10 -> 07-21).
    // A bumped lastReviewDate would instead see a 1-day span and diverge.
    const skippedItem = { ...item, ...result };
    const afterReview = applyReview(skippedItem, '2026-07-21', 'GOOD');
    const expectedR = fsrs.retrievability(10, 11);
    const expectedStability = fsrs.nextStability(5, 10, expectedR, 'GOOD');
    expect(afterReview.stability).toBeCloseTo(expectedStability, 10);
  });
});

describe('Fixed Mode uses the configurable final interval', () => {
  it('advances stage 1 -> 2 using the item’s own finalIntervalDays, not a hardcoded 30', () => {
    const item = makeItem({ stage: 1, nextReviewDate: '2026-07-20', finalIntervalDays: 90 });
    const result = applyReview(item, '2026-07-20');
    expect(result.nextReviewDate).toEqual(parseDate('2026-10-18')); // +90 from the 20th
  });
});

describe('Grade validation', () => {
  it('rejects an Adaptive review with no grade', () => {
    const item = makeAdaptiveItem({ nextReviewDate: '2026-07-20' });
    expect(() => applyReview(item, '2026-07-20')).toThrow(
      expect.objectContaining({ status: 400, code: 'GRADE_REQUIRED' }),
    );
  });

  it('rejects a Fixed review that carries a grade', () => {
    const item = makeItem({ stage: 0, nextReviewDate: '2026-07-20' });
    expect(() => applyReview(item, '2026-07-20', 'GOOD')).toThrow(
      expect.objectContaining({ status: 400, code: 'GRADE_NOT_ALLOWED' }),
    );
  });
});

describe('Adaptive Mode (FSRS)', () => {
  it('rejects an early review attempt, same as Fixed Mode', () => {
    const item = makeAdaptiveItem({ nextReviewDate: '2026-07-25' });
    expect(() => applyReview(item, '2026-07-20', 'GOOD')).toThrow(
      expect.objectContaining({ status: 409, code: 'ITEM_NOT_DUE' }),
    );
  });

  it('never archives, no matter the grade', () => {
    const item = makeAdaptiveItem({ nextReviewDate: '2026-07-20', difficulty: 5, stability: 10, lastReviewDate: '2026-06-01' });
    const result = applyReview(item, '2026-07-20', 'AGAIN');
    expect(result.isComplete).toBeUndefined(); // applyAdaptiveReview never sets it -- item.isComplete stays false
  });

  it('a first-ever GOOD review sets stability to FSRS’s published w[2] default, giving a ~2-day interval', () => {
    // Golden value: desiredRetention (0.9) equals the exponent base FACTOR is
    // derived from, so nextIntervalDays(S) reduces to round(S) exactly.
    const item = makeAdaptiveItem({ nextReviewDate: '2026-07-20' });
    const result = applyReview(item, '2026-07-20', 'GOOD');
    expect(result.stability).toBeCloseTo(fsrs.DEFAULT_PARAMETERS[2], 10);
    expect(result.nextReviewDate).toEqual(addDays(parseDate('2026-07-20'), Math.round(fsrs.DEFAULT_PARAMETERS[2])));
  });

  it('orders next intervals EASY > GOOD > HARD from the same prior state', () => {
    const base = { difficulty: 5, stability: 10, lastReviewDate: '2026-07-01' };
    const dueDate = '2026-07-20';
    const easy = applyReview(makeAdaptiveItem({ nextReviewDate: dueDate, ...base }), dueDate, 'EASY');
    const good = applyReview(makeAdaptiveItem({ nextReviewDate: dueDate, ...base }), dueDate, 'GOOD');
    const hard = applyReview(makeAdaptiveItem({ nextReviewDate: dueDate, ...base }), dueDate, 'HARD');
    expect(easy.stability).toBeGreaterThan(good.stability);
    expect(good.stability).toBeGreaterThan(hard.stability);
  });

  it('AGAIN shrinks stability and raises difficulty; EASY does the opposite', () => {
    const base = { difficulty: 5, stability: 10, lastReviewDate: '2026-07-01' };
    const dueDate = '2026-07-20';
    const again = applyReview(makeAdaptiveItem({ nextReviewDate: dueDate, ...base }), dueDate, 'AGAIN');
    const easy = applyReview(makeAdaptiveItem({ nextReviewDate: dueDate, ...base }), dueDate, 'EASY');
    expect(again.stability).toBeLessThan(base.stability);
    expect(again.difficulty).toBeGreaterThan(base.difficulty);
    expect(easy.difficulty).toBeLessThan(base.difficulty);
  });
});

describe('fsrs.retrievability / fsrs.nextIntervalDays round-trip', () => {
  it('retrievability at exactly the computed next interval is ~90% (the desired retention)', () => {
    const stability = 15.4321;
    const interval = fsrs.nextIntervalDays(stability);
    expect(fsrs.retrievability(stability, interval)).toBeCloseTo(fsrs.DESIRED_RETENTION, 2);
  });
});

describe('start-of-life state (Reset / Mode switch share this)', () => {
  it('Fixed start-of-life: stage 0, due in 2 days, no FSRS state, keeps the given finalIntervalDays', () => {
    expect(fixedStartOfLife('2026-07-20', 45)).toEqual({
      mode: 'FIXED',
      stage: 0,
      isComplete: false,
      nextReviewDate: parseDate('2026-07-22'),
      finalIntervalDays: 45,
      difficulty: null,
      stability: null,
      lastReviewDate: null,
    });
  });

  it('Adaptive start-of-life: due today, no FSRS state yet', () => {
    expect(adaptiveStartOfLife('2026-07-20')).toEqual({
      mode: 'ADAPTIVE',
      stage: 0,
      isComplete: false,
      nextReviewDate: parseDate('2026-07-20'),
      difficulty: null,
      stability: null,
      lastReviewDate: null,
    });
  });
});
