const { z } = require('zod');

// z.coerce.boolean() would be wrong here -- JS Boolean("false") is true,
// since any non-empty string is truthy. Restricting to the two literal
// strings and transforming explicitly avoids that foot-gun.
const exportQuerySchema = z.object({
  includeDeleted: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

module.exports = { exportQuerySchema };
