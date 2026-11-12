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
      'insert into users (id, username, display_name, bio, avatar_url, password_hash, role, status, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [user.id, user.username, user.displayName, user.bio, user.avatarUrl || '', user.passwordHash, user.role, user.status, user.createdAt]
    );
    return user;
  }

  async function updateProfile(id, { username, displayName, bio, city, website, avatarUrl }) {
    const { rows } = await pool.query(
      'update users set username = $1, display_name = $2, bio = $3, city = $4, website = $5, avatar_url = $6 where id = $7 returning *',
      [username, displayName, bio, city || '', website || '', avatarUrl || '', id]
    );
    return userFromRow(rows[0]);
  }

  async function updatePassword(id, passwordHash) {
    await pool.query('update users set password_hash = $1 where id = $2', [passwordHash, id]);
  }

  return { findById, findByUsername, usernameExists, createUser, updateProfile, updatePassword };
}

module.exports = { createUsersRepository };
