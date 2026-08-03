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

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8, 'password must be at least 8 characters')
    .regex(/[A-Za-z]/, 'password must contain at least one letter')
    .regex(/[0-9]/, 'password must contain at least one number'),
});

// Shared by /auth/refresh and /auth/logout -- both just take the refresh
// token itself, no other fields.
const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

module.exports = { registerSchema, loginSchema, changePasswordSchema, refreshTokenSchema };
