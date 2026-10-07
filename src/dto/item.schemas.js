const { z } = require('zod');
const { dateStringSchema } = require('./shared.schemas');

const itemModeSchema = z.enum(['FIXED', 'ADAPTIVE']);

// Only meaningful for Fixed Mode items; harmlessly ignored for Adaptive
// ones rather than rejected -- it's a dormant setting, not an action whose
// mismatch could misrepresent what happened (contrast with Grade, which
// review.schemas.js does reject when it doesn't match the item's mode).
const finalIntervalDaysSchema = z.coerce.number().int().min(1).max(3650).default(30);

const createItemSchema = z.object({
  text: z.string().min(1).max(10000),
  date: dateStringSchema,
  mode: itemModeSchema.default('FIXED'),
  finalIntervalDays: finalIntervalDaysSchema,
});

const updateItemSchema = z.object({
  text: z.string().min(1).max(10000),
});

const listItemsQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const resetItemSchema = z.object({
  date: dateStringSchema,
});

const switchModeSchema = z.object({
  mode: itemModeSchema,
  date: dateStringSchema,
  finalIntervalDays: z.coerce.number().int().min(1).max(3650).optional(),
});

// date is optional and client-provided (same rule as dueQuerySchema/
// reviewHistoryQuerySchema) -- it only anchors the curve's "today" marker,
// so omitting it just means no marker rather than a server-clock guess.
const curveQuerySchema = z.object({
  date: dateStringSchema.optional(),
});

// date is the client's "today" (same rule as curveQuerySchema): it only
// extends the weekly list's empty weeks up to the current week. Optional so
// callers from before it existed keep working unchanged. The extra check
// rejects impossible dates like 2026-13-45, which the format regex alone
// lets through and which would otherwise roll over into a real-looking week.
const statsQuerySchema = z.object({
  date: dateStringSchema
    .refine((s) => {
      // zod still runs this when the regex above failed, so it must cope
      // with any string -- NaN parts just fail the comparisons.
      const [y, m, d] = s.split('-').map(Number);
      const date = new Date(Date.UTC(y, m - 1, d));
      return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
    }, 'date must be a real calendar date')
    .optional(),
});

module.exports = {
  createItemSchema,
  updateItemSchema,
  listItemsQuerySchema,
  resetItemSchema,
  switchModeSchema,
  curveQuerySchema,
  statsQuerySchema,
};
