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
// date, there's no correctness risk in defaulting it server-side.
const reviewHistoryQuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(9999).optional(),
});

module.exports = { reviewActionSchema, dueQuerySchema, reviewHistoryQuerySchema };
