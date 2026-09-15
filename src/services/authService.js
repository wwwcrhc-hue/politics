'use strict';

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createAuthService({ usersRepository, bcrypt, cleanText, makeId, now, signToken, publicUser }) {
  async function register(body) {
    const username = cleanText(body.username, 24);
    const displayName = cleanText(body.displayName, 40) || username;
    const password = String(body.password || '');
    if (!/^[A-Za-z0-9_\u0600-\u06FF]{3,24}$/.test(username)) throw createHttpError(400, 'اسم المستخدم بين 3 و24 حرفا وبدون مسافات');
    if (password.length < 8 || password.length > 128) throw createHttpError(400, 'كلمة المرور بين 8 و128 حرفا');
    if (await usersRepository.usernameExists(username)) throw createHttpError(409, 'اسم المستخدم مستخدم بالفعل');

    const user = { id: makeId('u'), username, displayName, bio: '', passwordHash: await bcrypt.hash(password, 12), createdAt: now(), role: 'user', status: 'active' };
    await usersRepository.createUser(user);
    return { token: signToken(user), user: publicUser(user) };
  }

  async function login(body) {
    const username = cleanText(body.username, 24);
    const password = String(body.password || '');
    const user = await usersRepository.findByUsername(username);
    if (!user || !(await bcrypt.compare(password, user.passwordHash || ''))) throw createHttpError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    if (user.status !== 'active') throw createHttpError(403, 'الحساب موقوف مؤقتًا');
    return { token: signToken(user), user: publicUser(user) };
  }

  async function getMe(userId) {
    const user = await usersRepository.findById(userId);
    if (!user) throw createHttpError(404, 'الحساب غير موجود');
    return publicUser(user);
  }

  async function updateMe(userId, body) {
    const user = await usersRepository.findById(userId);
    if (!user) throw createHttpError(404, 'الحساب غير موجود');
    const displayName = 'displayName' in body ? (cleanText(body.displayName, 40) || user.displayName) : user.displayName;
    const bio = 'bio' in body ? cleanText(body.bio, 180) : user.bio;
    return publicUser(await usersRepository.updateProfile(userId, { displayName, bio }));
  }

  return { register, login, getMe, updateMe };
}

module.exports = { createAuthService };
