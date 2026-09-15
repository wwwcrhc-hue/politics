'use strict';

function createRoomPermissionsService({ sharedRepository }) {
  async function userIsAdmin(id) {
    const user = await sharedRepository.getUserById(id);
    return user?.role === 'admin';
  }

  async function canManageRoom(userId, room) {
    return !!room && (room.owner_user_id === userId || (await userIsAdmin(userId)));
  }

  async function roomPower(userId, room) {
    if (!room || !userId) return { role: 'guest', canModerate: false, canManage: false, banned: false };
    if (await userIsAdmin(userId)) return { role: 'admin', canModerate: true, canManage: true, banned: false };
    if (room.owner_user_id === userId) return { role: 'owner', canModerate: true, canManage: true, banned: false };
    const member = await sharedRepository.getRoomMembership(room.id, userId);
    return {
      role: member?.role || 'member',
      canModerate: member?.role === 'moderator' && member?.status !== 'banned',
      canManage: false,
      banned: member?.status === 'banned'
    };
  }

  async function canModerateRoom(userId, room) {
    return (await roomPower(userId, room)).canModerate;
  }

  return { userIsAdmin, canManageRoom, roomPower, canModerateRoom };
}

module.exports = { createRoomPermissionsService };
