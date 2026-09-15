'use strict';

const express = require('express');
const { createPostsController } = require('../controllers/postsController');
const { createPostsRepository } = require('../repositories/postsRepository');
const { createPostsService } = require('../services/postsService');

function createPostsRouter(dependencies) {
  const router = express.Router();
  const postsRepository = createPostsRepository(dependencies);
  const postsService = createPostsService({ ...dependencies, postsRepository });
  const controller = createPostsController({ ...dependencies, postsService });

  router.get('/feed', controller.listFeed);
  router.post('/posts', dependencies.auth, dependencies.requireActiveUser, dependencies.upload.array('media', 4), controller.createPost);
  router.patch('/posts/:id', dependencies.auth, dependencies.requireActiveUser, controller.updatePost);
  router.delete('/posts/:id', dependencies.auth, dependencies.requireActiveUser, controller.deletePost);
  router.post('/posts/:id/like', dependencies.auth, dependencies.requireActiveUser, controller.toggleLike);
  router.get('/posts/:id/comments', controller.listComments);
  router.post('/posts/:id/comments', dependencies.auth, dependencies.requireActiveUser, controller.createComment);
  router.delete('/comments/:id', dependencies.auth, dependencies.requireActiveUser, controller.deleteComment);

  return router;
}

module.exports = { createPostsRouter };
