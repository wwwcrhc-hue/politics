'use strict';

const express = require('express');
const { createAdminController } = require('../controllers/adminController');
const { createAdminRepository } = require('../repositories/adminRepository');
const { createAdminService } = require('../services/adminService');

function createAdminRouter(dependencies) {
  const router = express.Router();
  const adminRepository = createAdminRepository(dependencies);
  const adminService = createAdminService({ ...dependencies, adminRepository });
  const controller = createAdminController({ ...dependencies, adminService });

  router.use(dependencies.auth, dependencies.requireAdmin);
  router.get('/users', controller.listUsers);
  router.patch('/users/:id', controller.updateUser);
  router.delete('/users/:id', controller.deleteUser);
  router.get('/moderation-logs', controller.listModerationLogs);
  router.get('/active-sessions', controller.listActiveSessions);

  return router;
}

module.exports = { createAdminRouter };
