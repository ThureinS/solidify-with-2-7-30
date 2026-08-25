const { AppError } = require('./errorHandler');
const { DEMO_ACCOUNT_EMAIL } = require('../lib/demoAccount');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Server-side enforcement (ADR 0004) that the fixed demo account can never
// be mutated -- checked on the resolved user, not on which mount the
// request came in through, so this also protects the normal authenticated
// path in the (currently impossible, since the seed password isn't public)
// event that someone logs into this account directly.
function blockDemoWrites(req, res, next) {
  if (req.user?.email === DEMO_ACCOUNT_EMAIL && !SAFE_METHODS.has(req.method)) {
    return next(new AppError(403, 'DEMO_READ_ONLY', 'The demo account is read-only'));
  }
  next();
}

module.exports = blockDemoWrites;
