const authService = require('../services/auth.service');
const { toAuthUser } = require('../dto/auth.mappers');

async function register(req, res, next) {
  try {
    const user = await authService.registerUser(req.body);
    res.status(201).json(toAuthUser(user));
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const token = await authService.loginUser(req.body);
    res.json({ token });
  } catch (err) {
    next(err);
  }
}

function me(req, res) {
  res.json(toAuthUser(req.user));
}

module.exports = { register, login, me };
