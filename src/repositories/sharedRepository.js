'use strict';

function createSharedRepository({ pool, userFromRow }) {
  async function getUserById(id) {
    const { rows } = await pool.query('select * from users where id = $1', [id]);
    return userFromRow(rows[0]);
  }

  async function roomExists(roomId) {
    const { rowCount } = await pool.query('select 1 from rooms where id = $1', [roomId]);
    return rowCount > 0;
  }

  async function getRoomById(roomId) {
    const { rows } = await pool.query('select * from rooms where id = $1', [roomId]);
    return rows[0] || null;
  }

  async function getRoomMembership(roomId, userId) {
    const { rows } = await pool.query('select * from room_members where room_id = $1 and user_id = $2', [roomId, userId]);
    return rows[0] || null;
  }

  async function logModeration({ id, actorUserId, action, targetType, targetId, roomId, details, createdAt }) {
    await pool.query(
      'insert into moderation_logs (id, actor_user_id, action, target_type, target_id, room_id, details, created_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
      [id, actorUserId || null, action, targetType, targetId || '', roomId, JSON.stringify(details || {}), createdAt]
    );
  }

  async function getPostForViewer(postId, viewerId = '') {
    const { rows } = await pool.query(`
      select p.*, u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at,
        count(distinct l.id) as likes_count,
        count(distinct c.id) as comments_count,
        bool_or(case when l.user_id = $2 then true else false end) as liked_by_me
      from posts p
      join users u on u.id = p.user_id
      left join likes l on l.post_id = p.id
      left join comments c on c.post_id = p.id
      where p.id = $1
      group by p.id, u.id
    `, [postId, viewerId || '']);
    return rows[0] || null;
  }

  return { getUserById, roomExists, getRoomById, getRoomMembership, logModeration, getPostForViewer };
}

module.exports = { createSharedRepository };
