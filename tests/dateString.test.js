import { describe, it, expect } from 'vitest';
import { dateStringSchema } from '../src/dto/shared.schemas.js';
import { reviewActionSchema, dueQuerySchema } from '../src/dto/review.schemas.js';

describe('dateStringSchema', () => {
  it.each(['2026-01-05', '2026-12-31', '2028-02-29'])('accepts the real date %s', (date) => {
    expect(dateStringSchema.safeParse(date).success).toBe(true);
  });

  it.each(['2026-02-30', '2026-02-29', '2026-13-01', '2026-04-31', '2026-00-10'])(
    'rejects the impossible date %s',
    (date) => {
      expect(dateStringSchema.safeParse(date).success).toBe(false);
    }
  );

  it.each(['26-01-05', '2026/01/05', 'today', ''])('rejects the wrong format %s', (date) => {
    expect(dateStringSchema.safeParse(date).success).toBe(false);
  });
});

// Every endpoint shares the one schema, so one body and one query example
// are enough to show the check reaches them.
describe('endpoints using dateStringSchema', () => {
  it('review rejects an impossible date', () => {
    expect(reviewActionSchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
  });

  it('due list rejects an impossible date', () => {
    expect(dueQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false);
  });
});
