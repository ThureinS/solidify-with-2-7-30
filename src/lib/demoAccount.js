// The public read-only demo route (ADR 0004) always serves this exact
// account. Hardcoded, not env-configurable: an env var here would let a
// deploy's environment repoint the public unauthenticated route at a real
// user's data, exactly what ADR 0004 rejected by ruling out user opt-in.
const DEMO_ACCOUNT_EMAIL = 'stats-test@example.com';

module.exports = { DEMO_ACCOUNT_EMAIL };
