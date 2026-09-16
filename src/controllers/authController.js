'use strict';

function createAuthController({ authService }) {
  function handleError(error, res, next) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  async function register(req, res, next) {
    try {
      res.status(201).json(await authService.register(req.body));
    } catch (e) { handleError(e, res, next); }
  }

  async function login(req, res, next) {
    try {
      res.json(await authService.login(req.body));
    } catch (e) { handleError(e, res, next); }
  }

  async function getMe(req, res, next) {
    try {
      res.json(await authService.getMe(req.user.id));
    } catch (e) { handleError(e, res, next); }
  }

  async function updateMe(req, res, next) {
    try {
      res.json(await authService.updateMe(req.user.id, req.body));
    } catch (e) { handleError(e, res, next); }
  }

  return { register, login, getMe, updateMe };
}

module.exports = { createAuthController };
