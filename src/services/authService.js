'use strict';

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_\u0600-\u06FF]{3,24}$/;

function normalizeWebsite(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.length > 180) throw createHttpError(400, 'رابط الموقع طويل جدًا');
  const prepared = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(prepared);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password || url.href.length > 200) {
      throw new Error('invalid website');
    }
    return url.href;
  } catch {
    throw createHttpError(400, 'أدخل رابط موقع صحيح يبدأ بـ https://');
  }
}

function createAuthService({ usersRepository, bcrypt, cleanText, makeId, now, signToken, publicUser }) {
  async function register(body) {
    const username = cleanText(body.username, 24);
    const displayName = cleanText(body.displayName, 40) || username;
    const password = String(body.password || '');
    if (!USERNAME_PATTERN.test(username)) throw createHttpError(400, 'اسم المستخدم بين 3 و24 حرفا وبدون مسافات');
    if (password.length < 8 || password.length > 128) throw createHttpError(400, 'كلمة المرور بين 8 و128 حرفا');
    if (await usersRepository.usernameExists(username)) throw createHttpError(409, 'اسم المستخدم مستخدم بالفعل');

    const user = { id: makeId('u'), username, displayName, bio: '', avatarUrl: '', passwordHash: await bcrypt.hash(password, 12), createdAt: now(), role: 'user', status: 'active' };
    try {
      await usersRepository.createUser(user);
    } catch (error) {
      if (error.code === '23505') throw createHttpError(409, 'اسم المستخدم مستخدم بالفعل');
      throw error;
    }
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
    const username = 'username' in body ? cleanText(body.username, 24) : user.username;
    const usernameChanged = username !== user.username;
    if (usernameChanged && !USERNAME_PATTERN.test(username)) throw createHttpError(400, 'اسم المستخدم بين 3 و24 حرفا وبدون مسافات');
    const displayName = 'displayName' in body ? (cleanText(body.displayName, 40) || user.displayName) : user.displayName;
    const bio = 'bio' in body ? cleanText(body.bio, 240) : user.bio;
    const city = 'city' in body ? cleanText(body.city, 80) : user.city;
    const website = 'website' in body ? normalizeWebsite(body.website) : user.website;
    const avatarUrl = 'avatarUrl' in body ? cleanText(body.avatarUrl, 240) : user.avatarUrl;
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (usernameChanged) {
      if (!currentPassword || !(await bcrypt.compare(currentPassword, user.passwordHash || ''))) {
        throw createHttpError(403, 'لتغيير اسم المستخدم أدخل كلمة المرور الحالية');
      }
      if (username.toLowerCase() !== user.username.toLowerCase() && await usersRepository.usernameExists(username)) {
        throw createHttpError(409, 'اسم المستخدم مستخدم بالفعل');
      }
    }
    if (newPassword) {
      if (newPassword.length < 8 || newPassword.length > 128) throw createHttpError(400, 'كلمة المرور الجديدة بين 8 و128 حرفا');
      if (!(await bcrypt.compare(currentPassword, user.passwordHash || ''))) throw createHttpError(403, 'كلمة المرور الحالية غير صحيحة');
      if (newPassword === currentPassword) throw createHttpError(400, 'اختر كلمة مرور تختلف عن الحالية');
    }
    let updatedUser;
    try {
      updatedUser = await usersRepository.updateProfile(userId, { username, displayName, bio, city, website, avatarUrl });
    } catch (error) {
      if (error.code === '23505') throw createHttpError(409, 'اسم المستخدم مستخدم بالفعل');
      throw error;
    }
    if (newPassword) await usersRepository.updatePassword(userId, await bcrypt.hash(newPassword, 12));
    return publicUser(updatedUser);
  }

  return { register, login, getMe, updateMe };
}

module.exports = { createAuthService };
