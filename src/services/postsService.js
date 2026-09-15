'use strict';

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createPostsService({ postsRepository, cleanText, makeId, now, postView, getPostForViewer, roomExists, getRoomById, userIsAdmin, canModerateRoom, commentFromRow, userFromRow, publicUser, getUserById, deleteUploadUrl }) {
  async function listFeed(query) {
    const room = cleanText(query.room, 40);
    const q = cleanText(query.q, 100);
    return (await postsRepository.listFeed({ room, q })).map(postView);
  }

  async function createPost(userId, body, uploadedFiles) {
    const roomId = cleanText(body.roomId, 40);
    const text = cleanText(body.text, 4000);
    if (!(await roomExists(roomId))) throw createHttpError(400, 'الساحة غير موجودة');
    const files = (uploadedFiles || []).map(f => ({ url: `/uploads/${f.filename}`, type: f.mimetype.startsWith('image/') ? 'image' : 'video', mime: f.mimetype, name: cleanText(f.originalname, 120), size: f.size }));
    if (!text && !files.length) throw createHttpError(400, 'اكتب منشورا أو أرفق صورة/فيديو');
    const post = { id: makeId('p'), userId, roomId, text, media: files, createdAt: now(), editedAt: null };
    await postsRepository.createPost(post);
    return { roomId, view: await getPostForViewer(post.id, userId) };
  }

  async function updatePost(postId, userId, body) {
    const post = await postsRepository.findPost(postId);
    if (!post) throw createHttpError(404, 'المنشور غير موجود');
    if (post.user_id !== userId && !(await userIsAdmin(userId))) throw createHttpError(403, 'لا يمكنك تعديل هذا المنشور');
    await postsRepository.updatePostText(postId, cleanText(body.text, 4000), now());
    return { post, view: await getPostForViewer(post.id, userId) };
  }

  async function deletePost(postId, userId) {
    const post = await postsRepository.findPost(postId);
    if (!post) throw createHttpError(404, 'المنشور غير موجود');
    const room = await getRoomById(post.room_id);
    if (post.user_id !== userId && !(await canModerateRoom(userId, room))) throw createHttpError(403, 'لا يمكنك حذف هذا المنشور');
    for (const m of (post.media || [])) deleteUploadUrl(m.url);
    await postsRepository.deletePost(post.id);
    return { post };
  }

  async function toggleLike(postId, userId) {
    if (!(await postsRepository.postExists(postId))) throw createHttpError(404, 'المنشور غير موجود');
    const deleted = await postsRepository.unlikePost(postId, userId);
    const liked = deleted.rowCount === 0;
    if (liked) await postsRepository.likePost({ id: makeId('l'), postId, userId, createdAt: now() });
    return { liked, count: await postsRepository.countLikes(postId) };
  }

  async function listComments(postId) {
    const rows = await postsRepository.listComments(postId);
    return rows.map(r => ({ ...commentFromRow(r), author: publicUser(userFromRow(r)) }));
  }

  async function createComment(postId, userId, body) {
    if (!(await postsRepository.postExists(postId))) throw createHttpError(404, 'المنشور غير موجود');
    const text = cleanText(body.text, 1500);
    if (!text) throw createHttpError(400, 'اكتب التعليق');
    const comment = { id: makeId('c'), postId, userId, text, createdAt: now() };
    await postsRepository.createComment(comment);
    return { ...comment, author: publicUser(await getUserById(userId)) };
  }

  async function deleteComment(commentId, userId) {
    const comment = await postsRepository.findCommentForModeration(commentId);
    if (!comment) throw createHttpError(404, 'التعليق غير موجود');
    const room = await getRoomById(comment.room_id);
    if (comment.user_id !== userId && !(await canModerateRoom(userId, room))) throw createHttpError(403, 'لا يمكنك حذف هذا التعليق');
    await postsRepository.deleteComment(commentId);
    return { comment };
  }

  return { listFeed, createPost, updatePost, deletePost, toggleLike, listComments, createComment, deleteComment };
}

module.exports = { createPostsService };
