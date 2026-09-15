'use strict';

function createMappers({ rowTime }) {
  function publicUser(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
  }

  function userFromRow(row) {
    if (!row) return null;
    return {
      id: row.user_id || row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio || '',
      avatarUrl: row.avatar_url || '',
      passwordHash: row.password_hash,
      role: row.role || 'user',
      status: row.status || 'active',
      createdAt: rowTime(row.user_created_at || row.created_at)
    };
  }

  function postFromRow(row) {
    return {
      id: row.id,
      userId: row.user_id,
      roomId: row.room_id,
      text: row.text || '',
      media: Array.isArray(row.media) ? row.media : [],
      createdAt: rowTime(row.created_at),
      editedAt: rowTime(row.edited_at)
    };
  }

  function commentFromRow(row) {
    return { id: row.id, postId: row.post_id, userId: row.user_id, text: row.text, createdAt: rowTime(row.created_at) };
  }

  function messageFromRow(row) {
    return { id: row.id, roomId: row.room_id, userId: row.user_id, text: row.text, createdAt: rowTime(row.created_at) };
  }

  function postView(row) {
    const post = postFromRow(row);
    post.author = publicUser(userFromRow(row));
    post.likes = Number(row.likes_count || 0);
    post.comments = Number(row.comments_count || 0);
    post.likedByMe = Boolean(row.liked_by_me);
    return post;
  }

  return { publicUser, userFromRow, postFromRow, commentFromRow, messageFromRow, postView };
}

module.exports = { createMappers };
