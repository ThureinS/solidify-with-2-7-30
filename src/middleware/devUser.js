const { DEV_USER_ID } = require('../lib/devUser');

// TEMPORARY: stands in for real authentication until Part 5.
// Replaced there by middleware that reads req.userId from a verified JWT.
function devUser(req, res, next) {
  req.userId = DEV_USER_ID;
  next();
}

module.exports = devUser;
