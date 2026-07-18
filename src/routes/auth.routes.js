const express = require('express');
const validate = require('../middleware/validate');
const requireAuth = require('../middleware/auth');
const authRateLimit = require('../middleware/authRateLimit');
const controller = require('../controllers/auth.controller');
const { registerSchema, loginSchema } = require('../dto/auth.schemas');

const router = express.Router();

router.post('/register', authRateLimit, validate(registerSchema), controller.register);
router.post('/login', authRateLimit, validate(loginSchema), controller.login);
router.get('/me', requireAuth, controller.me);

module.exports = router;
