'use strict';

const express = require('express');
const { createAuthController } = require('../controllers/authController');
const { createAuthService } = require('../services/authService');
const { createUsersRepository } = require('../repositories/usersRepository');

function createAuthRouter(dependencies) {
  const router = express.Router();
  const usersRepository = createUsersRepository(dependencies);
  const authService = createAuthService({ ...dependencies, usersRepository });
  const controller = createAuthController({ authService });

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.get('/me', dependencies.auth, controller.getMe);
  router.patch('/me', dependencies.auth, dependencies.requireActiveUser, controller.updateMe);

  return router;
}

module.exports = { createAuthRouter };
