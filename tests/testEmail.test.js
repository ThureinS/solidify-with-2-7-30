import { describe, it, expect } from 'vitest';
import { isTestEmail } from '../src/lib/testEmail.js';

describe('isTestEmail', () => {
  it.each(['lane-d-x@example.com', 'demo@EXAMPLE.com', 'a@example.org', 'a@example.net', 'a@mail.example.com'])(
    'treats %s as a test address',
    (email) => {
      expect(isTestEmail(email)).toBe(true);
    }
  );

  it.each(['someone@gmail.com', 'a@notexample.com', 'a@example.com.evil.io', 'example.com@gmail.com'])(
    'treats %s as a real address',
    (email) => {
      expect(isTestEmail(email)).toBe(false);
    }
  );
});
