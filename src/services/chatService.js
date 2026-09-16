'use strict';

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createChatService({ chatRepository, getRoomById, canModerateRoom, messageFromRow, userFromRow, publicUser }) {
  async function listRoomMessages(roomId) {
    const rows = await chatRepository.listRoomMessages(roomId);
    return rows.reverse().map(r => ({ ...messageFromRow(r), author: publicUser(userFromRow(r)) }));
  }

  async function deleteMessage(messageId, userId) {
    const message = await chatRepository.findMessageForModeration(messageId);
    if (!message) throw createHttpError(404, 'الرسالة غير موجودة');

    const room = await getRoomById(message.room_id);
    if (message.user_id !== userId && !(await canModerateRoom(userId, room))) throw createHttpError(403, 'لا يمكنك حذف هذه الرسالة');

    await chatRepository.deleteMessage(messageId);
    return { message };
  }

  return { listRoomMessages, deleteMessage };
}

module.exports = { createChatService };
