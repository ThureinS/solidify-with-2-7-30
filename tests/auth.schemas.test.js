import { describe, it, expect } from 'vitest';
import { changePasswordSchema } from '../src/dto/auth.schemas.js';

describe('changePasswordSchema', () => {
  it('accepts a current password plus a valid new password', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'anything',
      newPassword: 'newpass123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a new password that fails the existing password rules', () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: 'anything',
      newPassword: 'short',
    });
    expect(result.success).toBe(false);
  });
});
