'use strict';

const express = require('express');
const { createChatController } = require('../controllers/chatController');
const { createChatRepository } = require('../repositories/chatRepository');
const { createChatService } = require('../services/chatService');

function createChatRouter(dependencies) {
  const router = express.Router();
  const chatRepository = createChatRepository(dependencies);
  const chatService = createChatService({ ...dependencies, chatRepository });
  const controller = createChatController({ ...dependencies, chatService });

  router.get('/chat/:roomId', controller.listRoomMessages);
  router.delete('/chat-messages/:id', dependencies.auth, dependencies.requireActiveUser, controller.deleteMessage);

  return router;
}

module.exports = { createChatRouter };
