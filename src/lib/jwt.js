const jwt = require('jsonwebtoken');

// Bumped to 15m as part of the refresh-token bonus (developer-handover.md
// §12b) -- the graded spec's 7-day single token lived here before. Long
// sessions now come from the refresh token, not this one.
const EXPIRES_IN = '15m';

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
