'use strict';

function createAdminRepository({ pool, userFromRow }) {
  async function listUsers() {
    const { rows } = await pool.query(`
      select u.id, u.username, u.display_name, u.bio, u.role, u.status, u.created_at,
        count(distinct p.id)::int as posts,
        count(distinct m.id)::int as messages
      from users u
      left join posts p on p.user_id = u.id
      left join room_messages m on m.user_id = u.id
      group by u.id
      order by u.created_at desc
      limit 500
    `);
    return rows;
  }

  async function findUserById(id) {
    const { rows } = await pool.query('select * from users where id = $1', [id]);
    return userFromRow(rows[0]);
  }

  async function updateUser(id, values) {
    const { rows } = await pool.query(
      'update users set role = $1, status = $2, display_name = $3, bio = $4 where id = $5 returning *',
      [values.role, values.status, values.displayName, values.bio, id]
    );
    return userFromRow(rows[0]);
  }

  async function deleteUser(id) {
    await pool.query('delete from users where id = $1', [id]);
  }

  async function listModerationLogs() {
    const { rows } = await pool.query('select ml.*,u.username,u.display_name from moderation_logs ml left join users u on u.id=ml.actor_user_id order by ml.created_at desc limit 500');
    return rows;
  }

  return { listUsers, findUserById, updateUser, deleteUser, listModerationLogs };
}

module.exports = { createAdminRepository };
