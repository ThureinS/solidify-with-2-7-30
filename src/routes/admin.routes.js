const express = require('express');
const validate = require('../middleware/validate');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/isAdmin');
const controller = require('../controllers/admin.controller');
const { listUsersQuerySchema } = require('../dto/admin.schemas');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/users', validate(listUsersQuerySchema, 'query'), controller.listUsers);
router.post('/users/:id/suspend', controller.suspendUser);
router.post('/users/:id/unsuspend', controller.unsuspendUser);

module.exports = router;
