const express = require('express');
const demoAuth = require('../middleware/demoAuth');
const buildItemsRouter = require('./items.routes');
const buildExportRouter = require('./export.routes');

// The public read-only demo mount (ADR 0004): same route tables as the real
// API, resolved to the fixed demo account instead of a bearer token.
const router = express.Router();
router.use('/items', buildItemsRouter(demoAuth));
router.use('/export', buildExportRouter(demoAuth));

module.exports = router;
