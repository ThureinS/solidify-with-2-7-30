const { z } = require('zod');
const { dateStringSchema } = require('./shared.schemas');

// Used for both POST /items/:id/review and POST /items/:id/skip.
const reviewActionSchema = z.object({
  date: dateStringSchema,
});

const dueQuerySchema = z.object({
  date: dateStringSchema,
});

// year is display scope, not a scheduling input -- unlike dueQuerySchema's
// date, there's no correctness risk in defaulting it server-side. date is
// here only to anchor the streak count (see getCurrentStreak) and follows
// the same client-provided-"today" rule as dueQuerySchema; it's optional so
// existing year/days-only callers keep working without it.
const reviewHistoryQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(9999).optional(),
  date: dateStringSchema.optional(),
});

module.exports = { reviewActionSchema, dueQuerySchema, reviewHistoryQuerySchema };
