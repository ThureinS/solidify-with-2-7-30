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
    const tokens = await authService.loginUser(req.body);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
}

function me(req, res) {
  res.json(toAuthUser(req.user));
}

async function changePassword(req, res, next) {
  try {
    const tokens = await authService.changePassword({ userId: req.userId, ...req.body });
    res.json(tokens);
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const tokens = await authService.refresh(req.body.refreshToken);
    res.json(tokens);
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    await authService.logout(req.body.refreshToken);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, me, changePassword, refresh, logout };
