const { z } = require('zod');
const { dateStringSchema } = require('./shared.schemas');

// Used for both POST /items/:id/review and POST /items/:id/skip.
const reviewActionSchema = z.object({
  date: dateStringSchema,
});

const dueQuerySchema = z.object({
  date: dateStringSchema,
});

module.exports = { reviewActionSchema, dueQuerySchema };
