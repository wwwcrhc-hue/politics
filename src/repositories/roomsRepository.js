'use strict';

function createRoomsRepository({ pool, userFromRow }) {
  async function listRooms() {
    const { rows } = await pool.query(`
      select r.id, r.name, r.description, r.owner_user_id, r.status, r.created_at,
        u.id as user_id,
        u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at,
        count(distinct p.id) as posts,
        count(distinct m.id) as messages
      from rooms r
      left join users u on u.id = r.owner_user_id
      left join posts p on p.room_id = r.id
      left join room_messages m on m.room_id = r.id
      group by r.id, u.id
      order by case when r.owner_user_id is null then 0 else 1 end, r.created_at asc, r.id asc
    `);
    return rows;
  }

  async function createRoom(room) {
    await pool.query(
      'insert into rooms (id, name, description, owner_user_id, created_at) values ($1, $2, $3, $4, $5)',
      [room.id, room.name, room.description, room.ownerUserId, room.createdAt]
    );
  }

  async function listPostMedia(roomId) {
    const posts = await pool.query('select media from posts where room_id = $1', [roomId]);
    return posts.rows;
  }

  async function deletePosts(roomId) {
    await pool.query('delete from posts where room_id = $1', [roomId]);
  }

  async function deleteRoom(roomId) {
    await pool.query('delete from rooms where id = $1', [roomId]);
  }

  async function updateRoom(roomId, { name, description }) {
    await pool.query('update rooms set name = $1, description = $2 where id = $3', [name, description, roomId]);
  }

  async function listMembers(roomId) {
    const { rows } = await pool.query('select rm.*, u.username, u.display_name, u.role as global_role from room_members rm join users u on u.id = rm.user_id where rm.room_id = $1 order by rm.created_at asc', [roomId]);
    return rows;
  }

  async function findUserByUsername(username) {
    const { rows } = await pool.query('select * from users where lower(username)=lower($1)', [username]);
    return userFromRow(rows[0]);
  }

  async function upsertMember({ id, roomId, userId, role, createdAt }) {
    await pool.query('insert into room_members (id,room_id,user_id,role,status,created_at) values ($1,$2,$3,$4,\'active\',$5) on conflict (room_id,user_id) do update set role=excluded.role,status=\'active\'', [id, roomId, userId, role, createdAt]);
  }

  async function updateMember({ roomId, userId, role, status }) {
    await pool.query('update room_members set role=$1,status=$2 where room_id=$3 and user_id=$4', [role, status, roomId, userId]);
  }

  async function deleteMember(roomId, userId) {
    await pool.query('delete from room_members where room_id=$1 and user_id=$2', [roomId, userId]);
  }

  async function updateStatus(roomId, status) {
    await pool.query('update rooms set status=$1 where id=$2', [status, roomId]);
  }

  return { listRooms, createRoom, listPostMedia, deletePosts, deleteRoom, updateRoom, listMembers, findUserByUsername, upsertMember, updateMember, deleteMember, updateStatus };
}

module.exports = { createRoomsRepository };
