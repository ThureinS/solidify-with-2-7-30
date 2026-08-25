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

module.exports = {
  createItemSchema,
  updateItemSchema,
  listItemsQuerySchema,
  resetItemSchema,
  switchModeSchema,
};
