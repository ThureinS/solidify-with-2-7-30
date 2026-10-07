import { describe, it, expect } from 'vitest';
import { toAuthUser } from '../src/dto/auth.mappers.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/lib/demoAccount.js';

function user(email) {
  return { id: 'u1', email, role: 'USER', isSuspended: false, createdAt: new Date('2026-10-07T00:00:00Z') };
}

describe('toAuthUser isDemo', () => {
  it('is true only for the demo account', () => {
    expect(toAuthUser(user(DEMO_ACCOUNT_EMAIL)).isDemo).toBe(true);
  });

  it('is false for a normal account', () => {
    expect(toAuthUser(user('someone@example.com')).isDemo).toBe(false);
  });
});
