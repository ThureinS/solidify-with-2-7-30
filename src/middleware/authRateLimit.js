const rateLimit = require('express-rate-limit');

// Throttles brute-force attempts on register/login only -- NOT /auth/me,
// which is a normal authenticated read and shouldn't share this budget.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res
      .status(429)
      .json({ error: { message: 'Too many attempts, please try again later', code: 'RATE_LIMITED' } });
  },
});

module.exports = authRateLimit;
