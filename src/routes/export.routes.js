const express = require('express');
const validate = require('../middleware/validate');
const blockDemoWrites = require('../middleware/blockDemoWrites');
const controller = require('../controllers/export.controller');
const { exportQuerySchema } = require('../dto/export.schemas');

// Same shared-route-table reasoning as items.routes.js: one factory serves
// both the real authenticated mount and the demo mount.
function buildExportRouter(identifyUser) {
  const router = express.Router();
  router.get('/', identifyUser, blockDemoWrites, validate(exportQuerySchema, 'query'), controller.exportData);
  return router;
}

module.exports = buildExportRouter;
