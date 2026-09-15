'use strict';

const express = require('express');
const { createHealthController } = require('../controllers/healthController');

function createHealthRouter(dependencies) {
  const router = express.Router();
  const controller = createHealthController(dependencies);

  router.get('/', controller.getHealth);

  return router;
}

module.exports = { createHealthRouter };
