const adminService = require('../services/admin.service');
const { toAuthUser } = require('../dto/auth.mappers');
const { AppError } = require('../middleware/errorHandler');

async function listUsers(req, res, next) {
  try {
    const { page, limit } = req.validatedQuery;
    const { users, total } = await adminService.listUsers({ page, limit });
    res.json({ users: users.map(toAuthUser), page, limit, total });
  } catch (err) {
    next(err);
  }
}

async function suspendUser(req, res, next) {
  try {
    if (req.params.id === req.userId) {
      throw new AppError(403, 'CANNOT_SUSPEND_SELF', 'Admins cannot suspend their own account');
    }
    await adminService.setSuspended(req.params.id, true);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function unsuspendUser(req, res, next) {
  try {
    await adminService.setSuspended(req.params.id, false);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { listUsers, suspendUser, unsuspendUser };
