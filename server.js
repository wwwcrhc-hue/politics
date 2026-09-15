'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Pool } = require('pg');
const { Server } = require('socket.io');
const { createAdminRouter } = require('./src/routes/adminRoutes');
const { createAuthRouter } = require('./src/routes/authRoutes');
const { createChatRouter } = require('./src/routes/chatRoutes');
const { createHealthRouter } = require('./src/routes/healthRoutes');
const { createPostsRouter } = require('./src/routes/postsRoutes');
const { createReportsRouter } = require('./src/routes/reportsRoutes');
const { createRoomsRouter } = require('./src/routes/roomsRoutes');
const { createRealtimeService } = require('./src/services/realtimeService');

const APP_NAME = 'ساحات سياسية';
const VERSION = '7.0.0';
const HOST = process.env.HOST || '0.0.0.0';
const START_PORT = normalizePort(process.env.PORT, 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-this-secret-before-public-deployment';
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const SCHEMA_FILE = path.join(ROOT_DIR, 'schema.sql');
const DATABASE_URL = process.env.DATABASE_URL || '';

for (const dir of [PUBLIC_DIR, UPLOAD_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase.co') ? { rejectUnauthorized: false } : undefined
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 2e6,
  pingTimeout: 20000,
  pingInterval: 25000
});

function normalizePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}
function now() { return new Date().toISOString(); }
function makeId(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`; }
function cleanText(v, max) { return String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max); }
function logError(error, context = '') {
  try { fs.appendFileSync(ERROR_LOG, `[${now()}] ${context}\n${error?.stack || error}\n\n`, 'utf8'); } catch {}
}
function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'يجب تسجيل الدخول أو تجديد الجلسة' }); }
}
async function requireAdmin(req, res, next) {
  try {
    const user = await getUserById(req.user.id);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'هذه الميزة متاحة للمدير فقط' });
    req.fullUser = user;
    next();
  } catch (e) { next(e); }
}
async function requireActiveUser(req, res, next) {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
    if (user.status !== 'active') return res.status(403).json({ error: 'حسابك موقوف مؤقتًا ولا يملك صلاحية تنفيذ هذا الإجراء' });
    req.fullUser = user;
    next();
  } catch (e) { next(e); }
}
function decodeSocketToken(token) {
  try { return jwt.verify(String(token || ''), JWT_SECRET); } catch { return null; }
}
function rowTime(v) { return v?.toISOString?.() || v || null; }
function userFromRow(row) {
  if (!row) return null;
  return {
    id: row.user_id || row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio || '',
    passwordHash: row.password_hash,
    role: row.role || 'user',
    status: row.status || 'active',
    createdAt: rowTime(row.user_created_at || row.created_at)
  };
}
function postFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    roomId: row.room_id,
    text: row.text || '',
    media: Array.isArray(row.media) ? row.media : [],
    createdAt: rowTime(row.created_at),
    editedAt: rowTime(row.edited_at)
  };
}
function commentFromRow(row) {
  return { id: row.id, postId: row.post_id, userId: row.user_id, text: row.text, createdAt: rowTime(row.created_at) };
}
function messageFromRow(row) {
  return { id: row.id, roomId: row.room_id, userId: row.user_id, text: row.text, createdAt: rowTime(row.created_at) };
}
function postView(row) {
  const post = postFromRow(row);
  post.author = publicUser(userFromRow(row));
  post.likes = Number(row.likes_count || 0);
  post.comments = Number(row.comments_count || 0);
  post.likedByMe = Boolean(row.liked_by_me);
  return post;
}

async function initDb() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is missing in .env');
  await pool.query(fs.readFileSync(SCHEMA_FILE, 'utf8'));
}
async function getUserById(id) {
  const { rows } = await pool.query('select * from users where id = $1', [id]);
  return userFromRow(rows[0]);
}
async function userIsAdmin(id) {
  const user = await getUserById(id);
  return user?.role === 'admin';
}
async function roomExists(roomId) {
  const { rowCount } = await pool.query('select 1 from rooms where id = $1', [roomId]);
  return rowCount > 0;
}
async function getRoomById(roomId) {
  const { rows } = await pool.query('select * from rooms where id = $1', [roomId]);
  return rows[0] || null;
}
async function canManageRoom(userId, room) {
  return !!room && (room.owner_user_id === userId || (await userIsAdmin(userId)));
}
async function getRoomMembership(roomId, userId) {
  const { rows } = await pool.query('select * from room_members where room_id = $1 and user_id = $2', [roomId, userId]);
  return rows[0] || null;
}
async function roomPower(userId, room) {
  if (!room || !userId) return { role: 'guest', canModerate: false, canManage: false, banned: false };
  if (await userIsAdmin(userId)) return { role: 'admin', canModerate: true, canManage: true, banned: false };
  if (room.owner_user_id === userId) return { role: 'owner', canModerate: true, canManage: true, banned: false };
  const member = await getRoomMembership(room.id, userId);
  return {
    role: member?.role || 'member',
    canModerate: member?.role === 'moderator' && member?.status !== 'banned',
    canManage: false,
    banned: member?.status === 'banned'
  };
}
async function canModerateRoom(userId, room) { return (await roomPower(userId, room)).canModerate; }
async function logModeration(actorUserId, action, targetType, targetId, roomId = null, details = {}) {
  try {
    await pool.query(`insert into moderation_logs (id, actor_user_id, action, target_type, target_id, room_id, details, created_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [makeId('mod'), actorUserId || null, action, targetType, targetId || '', roomId, JSON.stringify(details || {}), now()]);
  } catch (e) { logError(e, 'logModeration'); }
}
function deleteUploadUrl(url, baseDir = UPLOAD_DIR) {
  if (!url?.startsWith('/uploads/')) return;
  try { fs.unlinkSync(path.join(baseDir, path.basename(url))); } catch {}
}
async function getPostForViewer(postId, viewerId = '') {
  const { rows } = await pool.query(`
    select p.*, u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at,
      count(distinct l.id) as likes_count,
      count(distinct c.id) as comments_count,
      bool_or(case when l.user_id = $2 then true else false end) as liked_by_me
    from posts p
    join users u on u.id = p.user_id
    left join likes l on l.post_id = p.id
    left join comments c on c.post_id = p.id
    where p.id = $1
    group by p.id, u.id
  `, [postId, viewerId || '']);
  return rows[0] ? postView(rows[0]) : null;
}

const allowedMime = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov']
]);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${allowedMime.get(file.mimetype) || ''}`)
});
const upload = multer({
  storage,
  limits: { files: 4, fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => allowedMime.has(file.mimetype) ? cb(null, true) : cb(new Error('نوع الملف غير مسموح. استخدم صور JPG/PNG/WEBP/GIF أو فيديو MP4/WEBM/MOV.'))
});

const realtime = createRealtimeService({ io, pool, cleanText, decodeSocketToken, getUserById, getRoomById, roomPower, publicUser, makeId, now, logError, logModeration });

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false, maxAge: '1h', setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));

app.use('/api/health', createHealthRouter({ pool, appName: APP_NAME, version: VERSION, now, getPort: () => server.address()?.port || null }));

app.use('/api/rooms', createRoomsRouter({ pool, io, auth, requireActiveUser, cleanText, makeId, now, rowTime, publicUser, userFromRow, getRoomById, canManageRoom, roomPower, canModerateRoom, getRoomMembership, logModeration, deleteUploadUrl, getLiveByRoom: () => realtime.liveByRoom }));

app.use('/api', createAuthRouter({ pool, bcrypt, cleanText, makeId, now, signToken, publicUser, userFromRow, auth, requireActiveUser }));

app.use('/api', createPostsRouter({ pool, io, auth, requireActiveUser, upload, cleanText, makeId, now, postView, getPostForViewer, roomExists, getRoomById, userIsAdmin, canModerateRoom, commentFromRow, userFromRow, publicUser, getUserById, deleteUploadUrl }));

app.use('/api', createReportsRouter({ pool, auth, requireActiveUser, requireAdmin, cleanText, makeId, now, rowTime, logModeration }));

app.use('/api', createChatRouter({ pool, io, auth, requireActiveUser, getRoomById, canModerateRoom, messageFromRow, userFromRow, publicUser }));

app.use('/api/admin', createAdminRouter({ pool, auth, requireAdmin, cleanText, rowTime, userFromRow, publicUser, getLiveByRoom: () => realtime.liveByRoom, getVoiceRooms: () => realtime.voiceRooms, livePublic: realtime.livePublic }));

realtime.registerHandlers();

app.get('/admin', (_req, res, next) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html'), e => e && next(e)));
app.get('/', (_req, res, next) => res.sendFile(path.join(PUBLIC_DIR, 'index.html'), e => e && next(e)));
app.use('/api', (_req, res) => res.status(404).json({ error: 'واجهة API غير موجودة' }));
app.get('*', (_req, res, next) => res.sendFile(path.join(PUBLIC_DIR, 'index.html'), e => e && next(e)));
app.use((error, req, res, next) => {
  logError(error, `${req.method} ${req.originalUrl}`);
  console.error(error);
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف أكبر من 200MB' : 'خطأ في رفع الملف' });
  res.status(error.status || 500).json({ error: 'حدث خطأ داخلي غير متوقع', details: process.env.NODE_ENV === 'production' ? undefined : String(error.message || error) });
});

function startServer(port = START_PORT, attempt = 0) {
  if (attempt >= 100 || port > 65535) {
    console.error('تعذر العثور على منفذ متاح');
    process.exitCode = 1;
    return;
  }
  const onError = error => {
    server.off('listening', onListening);
    if (error.code === 'EADDRINUSE') {
      console.log(`المنفذ ${port} مستخدم، تجربة ${port + 1}...`);
      return setTimeout(() => startServer(port + 1, attempt + 1), 100);
    }
    console.error(error);
  };
  const onListening = () => {
    server.off('error', onError);
    const actual = server.address().port;
    console.log(`\n${APP_NAME} ${VERSION}\nhttp://localhost:${actual}\nفحص: http://localhost:${actual}/api/health\n`);
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

initDb()
  .then(() => startServer())
  .catch(error => {
    logError(error, 'initDb');
    console.error(error);
    process.exitCode = 1;
  });

process.on('SIGINT', () => { io.close(() => server.close(() => pool.end(() => process.exit(0)))); });
process.on('SIGTERM', () => { io.close(() => server.close(() => pool.end(() => process.exit(0)))); });
