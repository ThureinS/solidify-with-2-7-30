const { z } = require('zod');

// The regex checks the shape only, so 2026-02-30 or 2026-13-45 would pass
// it -- and parseDate would silently roll them over into a real date
// (2026-03-02, 2027-01-14). The refine rejects them with a 400 instead.
const dateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format')
  .refine((s) => {
    // zod still runs this when the regex above failed, so it must cope
    // with any string -- NaN parts just fail the comparisons.
    const [y, m, d] = s.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'date must be a real calendar date');

module.exports = { dateStringSchema };
