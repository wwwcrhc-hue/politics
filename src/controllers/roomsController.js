'use strict';

function createRoomsController({ roomsService, io }) {
  function handleError(error, res, next) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }

  async function listRooms(_req, res, next) {
    try { res.json(await roomsService.listRooms()); } catch (e) { next(e); }
  }

  async function createRoom(req, res, next) {
    try { res.status(201).json(await roomsService.createRoom(req.user.id, req.fullUser, req.body)); } catch (e) { handleError(e, res, next); }
  }

  async function updateRoom(req, res, next) {
    try {
      const result = await roomsService.updateRoom(req.params.id, req.user.id, req.body);
      io.to(`room:${result.room.id}`).emit('room:updated', { roomId: result.room.id });
      res.json(result.response);
    } catch (e) { handleError(e, res, next); }
  }

  async function deleteRoom(req, res, next) {
    try {
      const { roomId } = await roomsService.deleteRoom(req.params.id, req.user.id);
      io.emit('room:deleted', { roomId });
      io.emit('feed:changed', { roomId });
      res.json({ ok: true });
    } catch (e) { handleError(e, res, next); }
  }

  async function getPermissions(req, res, next) {
    try { res.json(await roomsService.getPermissions(req.params.id, req.user.id)); } catch (e) { handleError(e, res, next); }
  }

  async function listMembers(req, res, next) {
    try { res.json(await roomsService.listMembers(req.params.id, req.user.id)); } catch (e) { handleError(e, res, next); }
  }

  async function addMember(req, res, next) {
    try { res.status(201).json(await roomsService.addMember(req.params.id, req.user.id, req.body)); } catch (e) { handleError(e, res, next); }
  }

  async function updateMember(req, res, next) {
    try {
      const { room, status } = await roomsService.updateMember(req.params.id, req.params.userId, req.user.id, req.body);
      if (status === 'banned') io.to(`room:${room.id}`).emit('room:user-banned', { roomId:room.id, userId:req.params.userId });
      res.json({ ok:true });
    } catch (e) { handleError(e, res, next); }
  }

  async function removeMember(req, res, next) {
    try { res.json(await roomsService.removeMember(req.params.id, req.params.userId, req.user.id)); } catch (e) { handleError(e, res, next); }
  }

  async function updateStatus(req, res, next) {
    try {
      const { room, status } = await roomsService.updateStatus(req.params.id, req.user.id, req.body);
      io.to(`room:${room.id}`).emit('room:status', { roomId:room.id, status });
      res.json({ ok:true, status });
    } catch (e) { handleError(e, res, next); }
  }

  return { listRooms, createRoom, updateRoom, deleteRoom, getPermissions, listMembers, addMember, updateMember, removeMember, updateStatus };
}

module.exports = { createRoomsController };
