const express = require('express');
const validate = require('../middleware/validate');
const requireAuth = require('../middleware/auth');
const controller = require('../controllers/export.controller');
const { exportQuerySchema } = require('../dto/export.schemas');

const router = express.Router();

router.get('/', requireAuth, validate(exportQuerySchema, 'query'), controller.exportData);

module.exports = router;
