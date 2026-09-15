'use strict';

function createChatRepository({ pool }) {
  async function listRoomMessages(roomId) {
    const { rows } = await pool.query(`
      select m.*, u.username, u.display_name, u.bio, u.avatar_url, u.role, u.created_at as user_created_at
      from room_messages m
      join users u on u.id = m.user_id
      where m.room_id = $1
      order by m.created_at desc
      limit 150
    `, [roomId]);
    return rows;
  }

  async function findMessageForModeration(messageId) {
    const { rows } = await pool.query(`
      select m.*, r.owner_user_id
      from room_messages m
      join rooms r on r.id = m.room_id
      where m.id = $1
    `, [messageId]);
    return rows[0] || null;
  }

  async function deleteMessage(messageId) {
    await pool.query('delete from room_messages where id = $1', [messageId]);
  }

  return { listRoomMessages, findMessageForModeration, deleteMessage };
}

module.exports = { createChatRepository };
