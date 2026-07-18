const exportService = require('../services/export.service');
const { toAuthUser } = require('../dto/auth.mappers');
const { toExportItem } = require('../dto/item.mappers');

async function exportData(req, res, next) {
  try {
    const { includeDeleted } = req.validatedQuery;
    const { user, items } = await exportService.exportUserData(req.userId, includeDeleted);
    res.json({ user: toAuthUser(user), items: items.map(toExportItem) });
  } catch (err) {
    next(err);
  }
}

module.exports = { exportData };
