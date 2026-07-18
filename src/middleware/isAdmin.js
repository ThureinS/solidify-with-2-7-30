const { AppError } = require('./errorHandler');

// Assumes requireAuth already ran and set req.user.
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'ADMIN') {
    return next(new AppError(403, 'ADMIN_ONLY', 'Admin access required'));
  }
  next();
}

module.exports = requireAdmin;
