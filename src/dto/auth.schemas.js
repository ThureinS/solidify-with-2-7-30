const { z } = require('zod');

const registerSchema = z.object({
  email: z.email(),
  password: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .regex(/[A-Za-z]/, 'password must contain at least one letter')
    .regex(/[0-9]/, 'password must contain at least one number'),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

module.exports = { registerSchema, loginSchema };
