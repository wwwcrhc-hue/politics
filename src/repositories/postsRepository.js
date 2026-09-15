'use strict';

function createPostsRepository({ pool }) {
  async function listFeed({ room, q }) {
    const params = [''];
    const where = [];
    if (room) { params.push(room); where.push(`p.room_id = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`p.text ilike $${params.length}`); }
    const { rows } = await pool.query(`
      select p.*, u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at,
        count(distinct l.id) as likes_count,
        count(distinct c.id) as comments_count,
        bool_or(case when l.user_id = $1 then true else false end) as liked_by_me
      from posts p
      join users u on u.id = p.user_id
      left join likes l on l.post_id = p.id
      left join comments c on c.post_id = p.id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      group by p.id, u.id
      order by p.created_at desc
      limit 250
    `, params);
    return rows;
  }

  async function createPost(post) {
    await pool.query(
      'insert into posts (id, user_id, room_id, text, media, created_at, edited_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7)',
      [post.id, post.userId, post.roomId, post.text, JSON.stringify(post.media), post.createdAt, post.editedAt]
    );
  }

  async function findPost(id) {
    const { rows } = await pool.query('select * from posts where id = $1', [id]);
    return rows[0] || null;
  }

  async function updatePostText(id, text, editedAt) {
    await pool.query('update posts set text = $1, edited_at = $2 where id = $3', [text, editedAt, id]);
  }

  async function deletePost(id) {
    await pool.query('delete from posts where id = $1', [id]);
  }

  async function postExists(id) {
    const post = await pool.query('select 1 from posts where id = $1', [id]);
    return post.rowCount > 0;
  }

  async function unlikePost(postId, userId) {
    return pool.query('delete from likes where post_id = $1 and user_id = $2', [postId, userId]);
  }

  async function likePost(like) {
    await pool.query('insert into likes (id, post_id, user_id, created_at) values ($1, $2, $3, $4)', [like.id, like.postId, like.userId, like.createdAt]);
  }

  async function countLikes(postId) {
    const count = await pool.query('select count(*)::int as count from likes where post_id = $1', [postId]);
    return count.rows[0].count;
  }

  async function listComments(postId) {
    const { rows } = await pool.query(`
      select c.*, u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at
      from comments c
      join users u on u.id = c.user_id
      where c.post_id = $1
      order by c.created_at asc
    `, [postId]);
    return rows;
  }

  async function createComment(comment) {
    await pool.query('insert into comments (id, post_id, user_id, text, created_at) values ($1, $2, $3, $4, $5)', [comment.id, comment.postId, comment.userId, comment.text, comment.createdAt]);
  }

  async function findCommentForModeration(commentId) {
    const { rows } = await pool.query('select c.*, p.room_id, r.owner_user_id from comments c join posts p on p.id = c.post_id join rooms r on r.id = p.room_id where c.id = $1', [commentId]);
    return rows[0] || null;
  }

  async function deleteComment(commentId) {
    await pool.query('delete from comments where id = $1', [commentId]);
  }

  return { listFeed, createPost, findPost, updatePostText, deletePost, postExists, unlikePost, likePost, countLikes, listComments, createComment, findCommentForModeration, deleteComment };
}

module.exports = { createPostsRepository };
