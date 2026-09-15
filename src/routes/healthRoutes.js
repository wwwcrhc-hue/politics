'use strict';

const express = require('express');
const { createHealthController } = require('../controllers/healthController');
const { createHealthRepository } = require('../repositories/healthRepository');

function createHealthRouter(dependencies) {
  const router = express.Router();
  const healthRepository = createHealthRepository(dependencies);
  const controller = createHealthController({ ...dependencies, healthRepository });

  router.get('/', controller.getHealth);

  return router;
}

module.exports = { createHealthRouter };
