'use strict';

function createRealtimeRepository({ pool }) {
  async function createRoomMessage(message) {
    await pool.query('insert into room_messages (id,room_id,user_id,text,created_at) values ($1,$2,$3,$4,$5)', [message.id, message.roomId, message.userId, message.text, message.createdAt]);
  }

  async function findUserIdByUsername(username) {
    const { rows } = await pool.query('select * from users where lower(username)=lower($1)', [username]);
    return rows[0]?.id || '';
  }

  async function banRoomUser({ id, roomId, userId, createdAt }) {
    await pool.query(
      `insert into room_members (id,room_id,user_id,role,status,created_at)
       values ($1,$2,$3,'member','banned',$4)
       on conflict (room_id,user_id) do update set status='banned'`,
      [id, roomId, userId, createdAt]
    );
  }

  return { createRoomMessage, findUserIdByUsername, banRoomUser };
}

module.exports = { createRealtimeRepository };
