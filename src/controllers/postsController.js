'use strict';

function createPostsController({ postsService, io }) {
  function handleError(error, res, next) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  async function listFeed(req, res, next) {
    try { res.json(await postsService.listFeed(req.query)); } catch (e) { next(e); }
  }

  async function createPost(req, res, next) {
    try {
      const { roomId, view } = await postsService.createPost(req.user.id, req.body, req.files);
      io.emit('feed:new', { roomId, post: view });
      res.status(201).json(view);
    } catch (e) { handleError(e, res, next); }
  }

  async function updatePost(req, res, next) {
    try {
      const { post, view } = await postsService.updatePost(req.params.id, req.user.id, req.body);
      io.emit('feed:changed', { roomId: post.room_id, postId: post.id });
      res.json(view);
    } catch (e) { handleError(e, res, next); }
  }

  async function deletePost(req, res, next) {
    try {
      const { post } = await postsService.deletePost(req.params.id, req.user.id);
      io.emit('feed:changed', { roomId: post.room_id, postId: post.id });
      res.json({ ok: true });
    } catch (e) { handleError(e, res, next); }
  }

  async function toggleLike(req, res, next) {
    try { res.json(await postsService.toggleLike(req.params.id, req.user.id)); } catch (e) { handleError(e, res, next); }
  }

  async function listComments(req, res, next) {
    try { res.json(await postsService.listComments(req.params.id)); } catch (e) { next(e); }
  }

  async function createComment(req, res, next) {
    try { res.status(201).json(await postsService.createComment(req.params.id, req.user.id, req.body)); } catch (e) { handleError(e, res, next); }
  }

  async function deleteComment(req, res, next) {
    try {
      const { comment } = await postsService.deleteComment(req.params.id, req.user.id);
      io.emit('feed:changed', { roomId: comment.room_id, postId: comment.post_id });
      res.json({ ok: true });
    } catch (e) { handleError(e, res, next); }
  }

  return { listFeed, createPost, updatePost, deletePost, toggleLike, listComments, createComment, deleteComment };
}

module.exports = { createPostsController };
