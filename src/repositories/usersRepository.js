'use strict';

function createUsersRepository({ pool, userFromRow }) {
  async function findById(id) {
    const { rows } = await pool.query('select * from users where id = $1', [id]);
    return userFromRow(rows[0]);
  }

  async function findByUsername(username) {
    const { rows } = await pool.query('select * from users where lower(username) = lower($1)', [username]);
    return userFromRow(rows[0]);
  }

  async function usernameExists(username) {
    const existing = await pool.query('select 1 from users where lower(username) = lower($1)', [username]);
    return existing.rowCount > 0;
  }

  async function createUser(user) {
    await pool.query(
      'insert into users (id, username, display_name, bio, password_hash, role, status, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [user.id, user.username, user.displayName, user.bio, user.passwordHash, user.role, user.status, user.createdAt]
    );
    return user;
  }

  async function updateProfile(id, { displayName, bio }) {
    const { rows } = await pool.query('update users set display_name = $1, bio = $2 where id = $3 returning *', [displayName, bio, id]);
    return userFromRow(rows[0]);
  }

  return { findById, findByUsername, usernameExists, createUser, updateProfile };
}

module.exports = { createUsersRepository };
