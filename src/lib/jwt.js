const jwt = require('jsonwebtoken');

// Refresh-token bonus (developer-handover.md §12b) -- the graded spec's
// 7-day single token lived here before. Long sessions now come from the
// refresh token, not this one. Started at 15m, bumped to 30m once rotation
// was confirmed working in prod.
const EXPIRES_IN = '30m';

// Read the secret at call time (not as a top-level const) so this module
// stays importable even if .env hasn't loaded yet, and so a missing secret
// fails loudly here instead of silently signing tokens with `undefined`.
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is not set');
  return secret;
}

function signToken(payload) {
  return jwt.sign(payload, getSecret(), { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

module.exports = { signToken, verifyToken };
