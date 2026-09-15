'use strict';

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createRoomsService({ roomsRepository, cleanText, makeId, now, rowTime, publicUser, userFromRow, getRoomById, canManageRoom, roomPower, canModerateRoom, getRoomMembership, logModeration, deleteUploadUrl, getLiveByRoom, livePublic }) {
  async function listRooms() {
    const rows = await roomsRepository.listRooms();
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status || 'active',
      ownerUserId: r.owner_user_id || null,
      owner: r.owner_user_id ? publicUser(userFromRow(r)) : null,
      createdAt: rowTime(r.created_at),
      posts: Number(r.posts),
      messages: Number(r.messages),
      live: getLiveByRoom().has(r.id) ? livePublic(getLiveByRoom().get(r.id)) : null
    }));
  }

  async function createRoom(userId, fullUser, body) {
    const name = cleanText(body.name, 60);
    const description = cleanText(body.description, 240);
    if (name.length < 3) throw createHttpError(400, 'اسم الغرفة يجب أن يكون 3 أحرف على الأقل');
    const room = { id: makeId('room'), name, description, ownerUserId: userId, createdAt: now() };
    await roomsRepository.createRoom(room);
    return { ...room, owner: publicUser(fullUser), posts: 0, messages: 0 };
  }

  async function updateRoom(roomId, userId, body) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    if (!(await canManageRoom(userId, room))) throw createHttpError(403, 'لا يمكنك إدارة هذه الغرفة');
    const name = cleanText(body.name, 60);
    const description = cleanText(body.description, 240);
    if (name.length < 3) throw createHttpError(400, 'اسم الغرفة يجب أن يكون 3 أحرف على الأقل');
    await roomsRepository.updateRoom(room.id, { name, description });
    return { room, response: { id: room.id, name, description, ownerUserId: room.owner_user_id || null } };
  }

  async function deleteRoom(roomId, userId) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    if (!(await canManageRoom(userId, room))) throw createHttpError(403, 'لا يمكنك حذف هذه الغرفة');
    const posts = await roomsRepository.listPostMedia(room.id);
    for (const p of posts) for (const m of (p.media || [])) deleteUploadUrl(m.url);
    await roomsRepository.deletePosts(room.id);
    await roomsRepository.deleteRoom(room.id);
    getLiveByRoom().delete(room.id);
    return { roomId: room.id };
  }

  async function getPermissions(roomId, userId) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    const power = await roomPower(userId, room);
    return { roomId: room.id, roomStatus: room.status || 'active', ...power, canCreatePosts: !power.banned && (room.status || 'active') === 'active' };
  }

  async function listMembers(roomId, userId) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    const power = await roomPower(userId, room);
    if (!power.canModerate) throw createHttpError(403, 'إدارة الأعضاء متاحة لمالك الغرفة ومشرفيها فقط');
    const rows = await roomsRepository.listMembers(room.id);
    return rows.map(r => ({ userId:r.user_id, username:r.username, displayName:r.display_name, role:r.role, status:r.status, globalRole:r.global_role, createdAt:rowTime(r.created_at) }));
  }

  async function addMember(roomId, actorUserId, body) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    if (!(await canModerateRoom(actorUserId, room))) throw createHttpError(403, 'لا يمكنك إضافة أعضاء لهذه الغرفة');
    const username = cleanText(body.username, 24);
    const role = cleanText(body.role, 20) === 'moderator' ? 'moderator' : 'member';
    const target = await roomsRepository.findUserByUsername(username);
    if (!target) throw createHttpError(404, 'المستخدم غير موجود');
    if (target.id === room.owner_user_id) throw createHttpError(400, 'هذا المستخدم هو مالك الغرفة بالفعل');
    await roomsRepository.upsertMember({ id: makeId('rm'), roomId: room.id, userId: target.id, role, createdAt: now() });
    await logModeration(actorUserId, 'room_member_add', 'user', target.id, room.id, { role });
    return { ok:true, user:publicUser(target), role };
  }

  async function updateMember(roomId, targetUserId, actorUserId, body) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    if (!(await canModerateRoom(actorUserId, room))) throw createHttpError(403, 'لا يمكنك إدارة أعضاء هذه الغرفة');
    const role = ['member','moderator'].includes(body.role) ? body.role : null;
    const status = ['active','banned'].includes(body.status) ? body.status : null;
    const current = await getRoomMembership(room.id, targetUserId);
    if (!current) throw createHttpError(404, 'العضو غير موجود في قائمة الغرفة');
    await roomsRepository.updateMember({ roomId: room.id, userId: targetUserId, role: role || current.role, status: status || current.status });
    await logModeration(actorUserId, 'room_member_update', 'user', targetUserId, room.id, { role, status });
    return { room, status };
  }

  async function removeMember(roomId, targetUserId, actorUserId) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    if (!(await canModerateRoom(actorUserId, room))) throw createHttpError(403, 'لا يمكنك إزالة أعضاء هذه الغرفة');
    await roomsRepository.deleteMember(room.id, targetUserId);
    await logModeration(actorUserId, 'room_member_remove', 'user', targetUserId, room.id, {});
    return { ok:true };
  }

  async function updateStatus(roomId, actorUserId, body) {
    const room = await getRoomById(roomId);
    if (!room) throw createHttpError(404, 'الغرفة غير موجودة');
    if (!(await canManageRoom(actorUserId, room))) throw createHttpError(403, 'إغلاق الغرفة متاح للمالك أو الإدارة فقط');
    const status = body.status === 'closed' ? 'closed' : 'active';
    await roomsRepository.updateStatus(room.id, status);
    await logModeration(actorUserId, 'room_status', 'room', room.id, room.id, { status });
    return { room, status };
  }

  return { listRooms, createRoom, updateRoom, deleteRoom, getPermissions, listMembers, addMember, updateMember, removeMember, updateStatus };
}

module.exports = { createRoomsService };
