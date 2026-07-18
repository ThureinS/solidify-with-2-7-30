import { describe, it, expect } from 'vitest';
import { isDueOn, applyReview, applySkip } from '../src/services/schedule.service.js';
import { parseDate } from '../src/lib/dates.js';

function makeItem({ stage = 0, nextReviewDate, isComplete = false }) {
  return { stage, nextReviewDate: parseDate(nextReviewDate), isComplete };
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
});
