const rateLimit = require('express-rate-limit');

// Applies to every request (the stricter authRateLimit on
// /auth/login and /auth/register layers on top of this, not instead of it).
const generalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res
      .status(429)
      .json({ error: { message: 'Too many requests, please try again later', code: 'RATE_LIMITED' } });
  },
});

module.exports = generalRateLimit;
