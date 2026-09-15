'use strict';

function createRealtimeRepository({ pool }) {
  async function createRoomMessage(message) {
    await pool.query('insert into room_messages (id,room_id,user_id,text,created_at) values ($1,$2,$3,$4,$5)', [message.id, message.roomId, message.userId, message.text, message.createdAt]);
  }

  async function findUserIdByUsername(username) {
    const { rows } = await pool.query('select * from users where lower(username)=lower($1)', [username]);
    return rows[0]?.id || '';
  }

  return { createRoomMessage, findUserIdByUsername };
}

module.exports = { createRealtimeRepository };
