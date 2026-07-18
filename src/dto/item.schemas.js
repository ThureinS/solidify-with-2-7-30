const { z } = require('zod');

const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format');

const createItemSchema = z.object({
  text: z.string().min(1).max(10000),
  date: dateStringSchema,
});

const updateItemSchema = z.object({
  text: z.string().min(1).max(10000),
});

const listItemsQuerySchema = z.object({
  status: z.enum(['active', 'archived', 'all']).default('active'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = { createItemSchema, updateItemSchema, listItemsQuerySchema };
