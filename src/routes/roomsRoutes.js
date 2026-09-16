'use strict';

const express = require('express');
const { createRoomsController } = require('../controllers/roomsController');
const { createRoomsRepository } = require('../repositories/roomsRepository');
const { createRoomsService } = require('../services/roomsService');

function createRoomsRouter(dependencies) {
  const router = express.Router();
  const roomsRepository = createRoomsRepository(dependencies);
  const roomsService = createRoomsService({ ...dependencies, roomsRepository });
  const controller = createRoomsController({ ...dependencies, roomsService });

  router.get('/', controller.listRooms);
  router.post('/', dependencies.auth, dependencies.requireActiveUser, controller.createRoom);
  router.patch('/:id', dependencies.auth, dependencies.requireActiveUser, controller.updateRoom);
  router.delete('/:id', dependencies.auth, dependencies.requireActiveUser, controller.deleteRoom);
  router.get('/:id/permissions', dependencies.auth, controller.getPermissions);
  router.get('/:id/members', dependencies.auth, controller.listMembers);
  router.post('/:id/members', dependencies.auth, dependencies.requireActiveUser, controller.addMember);
  router.patch('/:id/members/:userId', dependencies.auth, dependencies.requireActiveUser, controller.updateMember);
  router.delete('/:id/members/:userId', dependencies.auth, dependencies.requireActiveUser, controller.removeMember);
  router.patch('/:id/status', dependencies.auth, dependencies.requireActiveUser, controller.updateStatus);

  return router;
}

module.exports = { createRoomsRouter };
