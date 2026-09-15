'use strict';

function createAdminController({ adminService, publicUser }) {
  function handleError(error, res, next) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  async function listUsers(_req, res, next) {
    try {
      res.json(await adminService.listUsers());
    } catch (e) { next(e); }
  }

  async function updateUser(req, res, next) {
    try {
      res.json(publicUser(await adminService.updateUser(req.params.id, req.body)));
    } catch (e) { handleError(e, res, next); }
  }

  async function deleteUser(req, res, next) {
    try {
      res.json(await adminService.deleteUser(req.params.id));
    } catch (e) { handleError(e, res, next); }
  }

  async function listModerationLogs(_req, res, next) {
    try {
      res.json(await adminService.listModerationLogs());
    } catch (e) { next(e); }
  }

  function listActiveSessions(_req, res) {
    res.json(adminService.listActiveSessions());
  }

  return { listUsers, updateUser, deleteUser, listModerationLogs, listActiveSessions };
}

module.exports = { createAdminController };
