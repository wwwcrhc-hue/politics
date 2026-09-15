'use strict';

const express = require('express');
const { createReportsController } = require('../controllers/reportsController');
const { createReportsRepository } = require('../repositories/reportsRepository');
const { createReportsService } = require('../services/reportsService');

function createReportsRouter(dependencies) {
  const router = express.Router();
  const reportsRepository = createReportsRepository(dependencies);
  const reportsService = createReportsService({ ...dependencies, reportsRepository });
  const controller = createReportsController({ reportsService });

  router.post('/reports', dependencies.auth, dependencies.requireActiveUser, controller.createReport);
  router.get('/admin/reports', dependencies.auth, dependencies.requireAdmin, controller.listReports);
  router.patch('/admin/reports/:id', dependencies.auth, dependencies.requireAdmin, controller.updateReportStatus);

  return router;
}

module.exports = { createReportsRouter };
