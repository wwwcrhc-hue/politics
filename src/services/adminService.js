'use strict';

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createAdminService({ adminRepository, cleanText, rowTime, getLiveByRoom, getVoiceRooms, livePublic }) {
  async function listUsers() {
    const rows = await adminRepository.listUsers();
    return rows.map(r => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      bio: r.bio,
      role: r.role,
      status: r.status || 'active',
      createdAt: rowTime(r.created_at),
      posts: Number(r.posts || 0),
      messages: Number(r.messages || 0)
    }));
  }

  async function updateUser(id, body) {
    const role = cleanText(body.role, 20);
    const status = cleanText(body.status, 20);
    const displayName = cleanText(body.displayName, 40);
    const bio = cleanText(body.bio, 180);
    if (role && !['user', 'moderator', 'admin'].includes(role)) throw createHttpError(400, 'الدور غير صحيح');
    if (status && !['active', 'suspended'].includes(status)) throw createHttpError(400, 'حالة الحساب غير صحيحة');

    const user = await adminRepository.findUserById(id);
    if (!user) throw createHttpError(404, 'الحساب غير موجود');

    return adminRepository.updateUser(id, {
      role: role || user.role,
      status: status || user.status,
      displayName: displayName || user.displayName,
      bio: 'bio' in body ? bio : user.bio
    });
  }

  async function deleteUser(id) {
    const user = await adminRepository.findUserById(id);
    if (!user) throw createHttpError(404, 'الحساب غير موجود');
    await adminRepository.deleteUser(id);
    return { ok: true };
  }

  async function listModerationLogs() {
    const rows = await adminRepository.listModerationLogs();
    return rows.map(r => ({ id:r.id, action:r.action, targetType:r.target_type, targetId:r.target_id, roomId:r.room_id, details:r.details || {}, createdAt:rowTime(r.created_at), actor:r.actor_user_id ? { username:r.username, displayName:r.display_name } : null }));
  }

  function listActiveSessions() {
    const liveByRoom = getLiveByRoom();
    const voiceRooms = getVoiceRooms();
    return {
      live: [...liveByRoom.values()].map(livePublic),
      voice: [...voiceRooms.entries()].map(([roomId, state]) => ({ roomId, participants: [...state.participants.values()].map(p => ({ socketId:p.socketId, user:p.user, role:p.role, muted:!!p.muted })) }))
    };
  }

  return { listUsers, updateUser, deleteUser, listModerationLogs, listActiveSessions };
}

module.exports = { createAdminService };
