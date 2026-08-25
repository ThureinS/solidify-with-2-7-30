const { z } = require('zod');
const { dateStringSchema } = require('./shared.schemas');

const gradeSchema = z.enum(['AGAIN', 'HARD', 'GOOD', 'EASY']);

// grade is optional here -- whether it's actually required depends on the
// item's mode, which this schema can't see. schedule.service.applyReview
// enforces that (GRADE_REQUIRED / GRADE_NOT_ALLOWED).
const reviewActionSchema = z.object({
  date: dateStringSchema,
  grade: gradeSchema.optional(),
});

// Skip never takes a grade, in either mode (CONTEXT.md). Its own schema,
// marked .strict(), rejects a stray grade with a 400 instead of zod's
// default of silently stripping it -- a client that thinks it graded a
// skip should find out immediately, not have that intent quietly dropped.
const skipActionSchema = z.object({
  date: dateStringSchema,
}).strict();

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

module.exports = { reviewActionSchema, skipActionSchema, dueQuerySchema, reviewHistoryQuerySchema };
