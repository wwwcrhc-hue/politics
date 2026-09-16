'use strict';

function createChatController({ chatService, io }) {
  function handleError(error, res, next) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  async function listRoomMessages(req, res, next) {
    try {
      res.json(await chatService.listRoomMessages(req.params.roomId));
    } catch (e) { next(e); }
  }

  async function deleteMessage(req, res, next) {
    try {
      const { message } = await chatService.deleteMessage(req.params.id, req.user.id);
      io.to(`room:${message.room_id}`).emit('room:message-deleted', { id: req.params.id, roomId: message.room_id });
      res.json({ ok: true });
    } catch (e) { handleError(e, res, next); }
  }

  return { listRoomMessages, deleteMessage };
}

module.exports = { createChatController };
