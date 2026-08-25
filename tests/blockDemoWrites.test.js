import { describe, it, expect, vi } from 'vitest';
import blockDemoWrites from '../src/middleware/blockDemoWrites.js';
import { DEMO_ACCOUNT_EMAIL } from '../src/lib/demoAccount.js';

function run(user, method) {
  const req = { user, method };
  const next = vi.fn();
  blockDemoWrites(req, {}, next);
  return next;
}

describe('blockDemoWrites', () => {
  it('rejects every mutating method for the demo account', () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const next = run({ email: DEMO_ACCOUNT_EMAIL }, method);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err.status).toBe(403);
      expect(err.code).toBe('DEMO_READ_ONLY');
    }
  });

  it('allows reads for the demo account', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const next = run({ email: DEMO_ACCOUNT_EMAIL }, method);
      expect(next).toHaveBeenCalledWith(); // called with no error
    }
  });

  it('never blocks a real account, mutating or not', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      const next = run({ email: 'real-user@example.com' }, method);
      expect(next).toHaveBeenCalledWith();
    }
  });
});
