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

const APP_NAME = 'ساحات سياسية';
const VERSION = '5.0.0';
const HOST = process.env.HOST || '0.0.0.0';
const START_PORT = normalizePort(process.env.PORT, 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-this-secret-before-public-deployment';
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
const RECORDING_DIR = path.join(UPLOAD_DIR, 'live-recordings');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const ERROR_LOG = path.join(LOG_DIR, 'error.log');
const SCHEMA_FILE = path.join(ROOT_DIR, 'schema.sql');
const DATABASE_URL = process.env.DATABASE_URL || '';

for (const dir of [PUBLIC_DIR, UPLOAD_DIR, RECORDING_DIR, LOG_DIR]) fs.mkdirSync(dir, { recursive: true });

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
const recordingStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, RECORDING_DIR),
  filename: (_req, file, cb) => {
    const ext = file.mimetype === 'video/mp4' ? '.mp4' : '.webm';
    cb(null, `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${ext}`);
  }
});
const recordingUpload = multer({
  storage: recordingStorage,
  limits: { files: 1, fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => ['video/webm', 'video/mp4'].includes(file.mimetype) ? cb(null, true) : cb(new Error('نوع تسجيل البث غير مدعوم'))
});

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
app.use('/uploads/live-recordings', auth, requireAdmin, express.static(RECORDING_DIR, { fallthrough: false, maxAge: '5m', setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use('/uploads', express.static(UPLOAD_DIR, { fallthrough: false, maxAge: '1h', setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));

app.get('/api/health', async (_req, res, next) => {
  try {
    await pool.query('select 1');
    res.json({ ok: true, app: APP_NAME, version: VERSION, storage: 'postgres', time: now(), port: server.address()?.port || null });
  } catch (e) { next(e); }
});

app.get('/api/rooms', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select r.id, r.name, r.description,
        count(distinct p.id) as posts,
        count(distinct m.id) as messages
      from rooms r
      left join posts p on p.room_id = r.id
      left join room_messages m on m.room_id = r.id
      group by r.id
      order by r.created_at asc, r.id asc
    `);
    res.json(rows.map(r => ({ id: r.id, name: r.name, description: r.description, posts: Number(r.posts), messages: Number(r.messages) })));
  } catch (e) { next(e); }
});

app.post('/api/register', async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 24);
    const displayName = cleanText(req.body.displayName, 40) || username;
    const password = String(req.body.password || '');
    if (!/^[A-Za-z0-9_\u0600-\u06FF]{3,24}$/.test(username)) return res.status(400).json({ error: 'اسم المستخدم بين 3 و24 حرفا وبدون مسافات' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'كلمة المرور بين 8 و128 حرفا' });
    const existing = await pool.query('select 1 from users where lower(username) = lower($1)', [username]);
    if (existing.rowCount) return res.status(409).json({ error: 'اسم المستخدم مستخدم بالفعل' });
    const user = { id: makeId('u'), username, displayName, bio: '', passwordHash: await bcrypt.hash(password, 12), createdAt: now(), role: 'user', status: 'active' };
    await pool.query(
      'insert into users (id, username, display_name, bio, password_hash, role, status, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [user.id, user.username, user.displayName, user.bio, user.passwordHash, user.role, user.status, user.createdAt]
    );
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { next(e); }
});

app.post('/api/login', async (req, res, next) => {
  try {
    const username = cleanText(req.body.username, 24);
    const password = String(req.body.password || '');
    const { rows } = await pool.query('select * from users where lower(username) = lower($1)', [username]);
    const user = userFromRow(rows[0]);
    if (!user || !(await bcrypt.compare(password, user.passwordHash || ''))) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    if (user.status !== 'active') return res.status(403).json({ error: 'الحساب موقوف مؤقتًا' });
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { next(e); }
});

app.get('/api/me', auth, async (req, res, next) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
    res.json(publicUser(user));
  } catch (e) { next(e); }
});

app.patch('/api/me', auth, requireActiveUser, async (req, res, next) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
    const displayName = 'displayName' in req.body ? (cleanText(req.body.displayName, 40) || user.displayName) : user.displayName;
    const bio = 'bio' in req.body ? cleanText(req.body.bio, 180) : user.bio;
    const { rows } = await pool.query('update users set display_name = $1, bio = $2 where id = $3 returning *', [displayName, bio, req.user.id]);
    res.json(publicUser(userFromRow(rows[0])));
  } catch (e) { next(e); }
});

app.get('/api/feed', async (req, res, next) => {
  try {
    const room = cleanText(req.query.room, 40);
    const q = cleanText(req.query.q, 100);
    const params = [''];
    const where = [];
    if (room) { params.push(room); where.push(`p.room_id = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`p.text ilike $${params.length}`); }
    const { rows } = await pool.query(`
      select p.*, u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at,
        count(distinct l.id) as likes_count,
        count(distinct c.id) as comments_count,
        bool_or(case when l.user_id = $1 then true else false end) as liked_by_me
      from posts p
      join users u on u.id = p.user_id
      left join likes l on l.post_id = p.id
      left join comments c on c.post_id = p.id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      group by p.id, u.id
      order by p.created_at desc
      limit 250
    `, params);
    res.json(rows.map(postView));
  } catch (e) { next(e); }
});

app.post('/api/posts', auth, requireActiveUser, upload.array('media', 4), async (req, res, next) => {
  try {
    const roomId = cleanText(req.body.roomId, 40);
    const text = cleanText(req.body.text, 4000);
    if (!(await roomExists(roomId))) return res.status(400).json({ error: 'الساحة غير موجودة' });
    const files = (req.files || []).map(f => ({ url: `/uploads/${f.filename}`, type: f.mimetype.startsWith('image/') ? 'image' : 'video', mime: f.mimetype, name: cleanText(f.originalname, 120), size: f.size }));
    if (!text && !files.length) return res.status(400).json({ error: 'اكتب منشورا أو أرفق صورة/فيديو' });
    const post = { id: makeId('p'), userId: req.user.id, roomId, text, media: files, createdAt: now(), editedAt: null };
    await pool.query(
      'insert into posts (id, user_id, room_id, text, media, created_at, edited_at) values ($1, $2, $3, $4, $5::jsonb, $6, $7)',
      [post.id, post.userId, post.roomId, post.text, JSON.stringify(post.media), post.createdAt, post.editedAt]
    );
    const view = await getPostForViewer(post.id, req.user.id);
    io.emit('feed:new', { roomId, post: view });
    res.status(201).json(view);
  } catch (e) { next(e); }
});

app.patch('/api/posts/:id', auth, requireActiveUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from posts where id = $1', [req.params.id]);
    const post = rows[0];
    if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
    if (post.user_id !== req.user.id && !(await userIsAdmin(req.user.id))) return res.status(403).json({ error: 'لا يمكنك تعديل هذا المنشور' });
    await pool.query('update posts set text = $1, edited_at = $2 where id = $3', [cleanText(req.body.text, 4000), now(), req.params.id]);
    io.emit('feed:changed', { roomId: post.room_id, postId: post.id });
    res.json(await getPostForViewer(post.id, req.user.id));
  } catch (e) { next(e); }
});

app.delete('/api/posts/:id', auth, requireActiveUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from posts where id = $1', [req.params.id]);
    const post = rows[0];
    if (!post) return res.status(404).json({ error: 'المنشور غير موجود' });
    if (post.user_id !== req.user.id && !(await userIsAdmin(req.user.id))) return res.status(403).json({ error: 'لا يمكنك حذف هذا المنشور' });
    for (const m of (post.media || [])) {
      if (m.url?.startsWith('/uploads/')) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, path.basename(m.url))); } catch {}
      }
    }
    await pool.query('delete from posts where id = $1', [post.id]);
    io.emit('feed:changed', { roomId: post.room_id, postId: post.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/posts/:id/like', auth, requireActiveUser, async (req, res, next) => {
  try {
    const post = await pool.query('select 1 from posts where id = $1', [req.params.id]);
    if (!post.rowCount) return res.status(404).json({ error: 'المنشور غير موجود' });
    const deleted = await pool.query('delete from likes where post_id = $1 and user_id = $2', [req.params.id, req.user.id]);
    const liked = deleted.rowCount === 0;
    if (liked) await pool.query('insert into likes (id, post_id, user_id, created_at) values ($1, $2, $3, $4)', [makeId('l'), req.params.id, req.user.id, now()]);
    const count = await pool.query('select count(*)::int as count from likes where post_id = $1', [req.params.id]);
    res.json({ liked, count: count.rows[0].count });
  } catch (e) { next(e); }
});

app.get('/api/posts/:id/comments', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select c.*, u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at
      from comments c
      join users u on u.id = c.user_id
      where c.post_id = $1
      order by c.created_at asc
    `, [req.params.id]);
    res.json(rows.map(r => ({ ...commentFromRow(r), author: publicUser(userFromRow(r)) })));
  } catch (e) { next(e); }
});

app.post('/api/posts/:id/comments', auth, requireActiveUser, async (req, res, next) => {
  try {
    const post = await pool.query('select 1 from posts where id = $1', [req.params.id]);
    if (!post.rowCount) return res.status(404).json({ error: 'المنشور غير موجود' });
    const text = cleanText(req.body.text, 1500);
    if (!text) return res.status(400).json({ error: 'اكتب التعليق' });
    const comment = { id: makeId('c'), postId: req.params.id, userId: req.user.id, text, createdAt: now() };
    await pool.query('insert into comments (id, post_id, user_id, text, created_at) values ($1, $2, $3, $4, $5)', [comment.id, comment.postId, comment.userId, comment.text, comment.createdAt]);
    res.status(201).json({ ...comment, author: publicUser(await getUserById(req.user.id)) });
  } catch (e) { next(e); }
});

app.delete('/api/comments/:id', auth, requireActiveUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query('select c.*, p.room_id from comments c join posts p on p.id = c.post_id where c.id = $1', [req.params.id]);
    const comment = rows[0];
    if (!comment) return res.status(404).json({ error: 'التعليق غير موجود' });
    if (comment.user_id !== req.user.id && !(await userIsAdmin(req.user.id))) return res.status(403).json({ error: 'لا يمكنك حذف هذا التعليق' });
    await pool.query('delete from comments where id = $1', [req.params.id]);
    io.emit('feed:changed', { roomId: comment.room_id, postId: comment.post_id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/reports', auth, requireActiveUser, async (req, res, next) => {
  try {
    await pool.query(
      'insert into reports (id, reporter_id, target_type, target_id, reason, status, created_at) values ($1, $2, $3, $4, $5, $6, $7)',
      [makeId('r'), req.user.id, cleanText(req.body.targetType, 20), cleanText(req.body.targetId, 80), cleanText(req.body.reason, 500), 'open', now()]
    );
    res.status(201).json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/chat/:roomId', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select m.*, u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at
      from room_messages m
      join users u on u.id = m.user_id
      where m.room_id = $1
      order by m.created_at desc
      limit 150
    `, [req.params.roomId]);
    res.json(rows.reverse().map(r => ({ ...messageFromRow(r), author: publicUser(userFromRow(r)) })));
  } catch (e) { next(e); }
});

app.delete('/api/chat-messages/:id', auth, requireActiveUser, async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from room_messages where id = $1', [req.params.id]);
    const message = rows[0];
    if (!message) return res.status(404).json({ error: 'الرسالة غير موجودة' });
    if (message.user_id !== req.user.id && !(await userIsAdmin(req.user.id))) return res.status(403).json({ error: 'لا يمكنك حذف هذه الرسالة' });
    await pool.query('delete from room_messages where id = $1', [req.params.id]);
    io.to(`room:${message.room_id}`).emit('room:message-deleted', { id: req.params.id, roomId: message.room_id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/admin/users', auth, requireAdmin, async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select u.id, u.username, u.display_name, u.bio, u.role, u.status, u.created_at,
        count(distinct p.id)::int as posts,
        count(distinct m.id)::int as messages
      from users u
      left join posts p on p.user_id = u.id
      left join room_messages m on m.user_id = u.id
      group by u.id
      order by u.created_at desc
      limit 500
    `);
    res.json(rows.map(r => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      bio: r.bio,
      role: r.role,
      status: r.status || 'active',
      createdAt: rowTime(r.created_at),
      posts: Number(r.posts || 0),
      messages: Number(r.messages || 0)
    })));
  } catch (e) { next(e); }
});

app.patch('/api/admin/users/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const role = cleanText(req.body.role, 20);
    const status = cleanText(req.body.status, 20);
    const displayName = cleanText(req.body.displayName, 40);
    const bio = cleanText(req.body.bio, 180);
    if (role && !['user', 'moderator', 'admin'].includes(role)) return res.status(400).json({ error: 'الدور غير صحيح' });
    if (status && !['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'حالة الحساب غير صحيحة' });
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
    const { rows } = await pool.query(
      'update users set role = $1, status = $2, display_name = $3, bio = $4 where id = $5 returning *',
      [role || user.role, status || user.status, displayName || user.displayName, 'bio' in req.body ? bio : user.bio, req.params.id]
    );
    res.json(publicUser(userFromRow(rows[0])));
  } catch (e) { next(e); }
});

app.delete('/api/admin/users/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const user = await getUserById(req.params.id);
    if (!user) return res.status(404).json({ error: 'الحساب غير موجود' });
    await pool.query('delete from users where id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/live-recordings', auth, requireActiveUser, recordingUpload.single('recording'), async (req, res, next) => {
  try {
    const roomId = cleanText(req.body.roomId, 40);
    if (!(await roomExists(roomId))) return res.status(400).json({ error: 'الساحة غير موجودة' });
    if (!req.file) return res.status(400).json({ error: 'لم يصل ملف التسجيل' });
    const user = await getUserById(req.user.id);
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    const startedAt = new Date(req.body.startedAt || now());
    const endedAt = new Date(req.body.endedAt || now());
    const durationMs = Math.max(0, Math.min(Number(req.body.durationMs || 0), 24 * 60 * 60 * 1000));
    const recording = {
      id: makeId('rec'),
      roomId,
      hostUserId: user.id,
      url: `/uploads/live-recordings/${req.file.filename}`,
      mime: req.file.mimetype,
      sizeBytes: req.file.size,
      durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : 0,
      startedAt: Number.isNaN(startedAt.getTime()) ? now() : startedAt.toISOString(),
      endedAt: Number.isNaN(endedAt.getTime()) ? now() : endedAt.toISOString(),
      createdAt: now()
    };
    await pool.query(
      `insert into live_recordings
        (id, room_id, host_user_id, url, mime, size_bytes, duration_ms, started_at, ended_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [recording.id, recording.roomId, recording.hostUserId, recording.url, recording.mime, recording.sizeBytes, recording.durationMs, recording.startedAt, recording.endedAt, recording.createdAt]
    );
    res.status(201).json(recording);
  } catch (e) { next(e); }
});

app.get('/api/live-recordings', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select lr.*, r.name as room_name, u.username, u.display_name
      from live_recordings lr
      join rooms r on r.id = lr.room_id
      join users u on u.id = lr.host_user_id
      order by lr.created_at desc
      limit 200
    `);
    res.json(rows.map(r => ({
      id: r.id,
      roomId: r.room_id,
      roomName: r.room_name,
      hostUserId: r.host_user_id,
      host: { username: r.username, displayName: r.display_name },
      url: r.url,
      mime: r.mime,
      sizeBytes: Number(r.size_bytes || 0),
      durationMs: Number(r.duration_ms || 0),
      startedAt: rowTime(r.started_at),
      endedAt: rowTime(r.ended_at),
      createdAt: rowTime(r.created_at)
    })));
  } catch (e) { next(e); }
});

app.get('/api/live-recordings/:id/file', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query('select * from live_recordings where id = $1', [req.params.id]);
    const recording = rows[0];
    if (!recording) return res.status(404).json({ error: 'التسجيل غير موجود' });
    const filename = path.basename(recording.url);
    res.setHeader('Content-Type', recording.mime || 'video/webm');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(path.join(RECORDING_DIR, filename), e => e && next(e));
  } catch (e) { next(e); }
});

app.delete('/api/live-recordings/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query('delete from live_recordings where id = $1 returning *', [req.params.id]);
    const recording = rows[0];
    if (!recording) return res.status(404).json({ error: 'التسجيل غير موجود' });
    try { fs.unlinkSync(path.join(RECORDING_DIR, path.basename(recording.url))); } catch {}
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const voiceRooms = new Map();
const liveByRoom = new Map();
function removeSocketFromRtc(socket) {
  for (const [roomId, set] of voiceRooms) {
    if (set.delete(socket.id)) {
      io.to(`voice:${roomId}`).emit('voice:user-left', { socketId: socket.id });
      if (!set.size) voiceRooms.delete(roomId);
      io.to(`room:${roomId}`).emit('voice:count', { roomId, count: set.size });
    }
  }
  for (const [roomId, live] of liveByRoom) {
    if (live.hostSocketId === socket.id) {
      liveByRoom.delete(roomId);
      io.to(`room:${roomId}`).emit('live:ended', { roomId });
    } else {
      io.to(live.hostSocketId).emit('live:viewer-left', { viewerSocketId: socket.id, roomId });
    }
  }
}

io.on('connection', socket => {
  socket.on('room:join', async roomId => {
    try {
      if (!(await roomExists(roomId))) return;
      for (const r of socket.rooms) if (String(r).startsWith('room:')) socket.leave(r);
      socket.join(`room:${roomId}`);
      const live = liveByRoom.get(roomId);
      socket.emit('live:status', live ? { active: true, ...live } : { active: false, roomId });
      socket.emit('voice:count', { roomId, count: voiceRooms.get(roomId)?.size || 0 });
    } catch (e) { logError(e, 'socket room:join'); }
  });
  socket.on('live:status-request', payload => {
    const roomId = cleanText(payload?.roomId, 40);
    const live = liveByRoom.get(roomId);
    socket.emit('live:status', live ? { active: true, ...live } : { active: false, roomId });
  });
  socket.on('room:message', async payload => {
    try {
      const decoded = decodeSocketToken(payload?.token);
      if (!decoded) return socket.emit('room:error', { error: 'سجل الدخول مرة أخرى' });
      const roomId = cleanText(payload?.roomId, 40);
      const text = cleanText(payload?.text, 1000);
      if (!text || !(await roomExists(roomId))) return;
      const user = await getUserById(decoded.id);
      if (!user) return;
      if (user.status !== 'active') return socket.emit('room:error', { error: 'حسابك موقوف مؤقتًا' });
      const m = { id: makeId('m'), roomId, userId: user.id, text, createdAt: now() };
      await pool.query('insert into room_messages (id, room_id, user_id, text, created_at) values ($1, $2, $3, $4, $5)', [m.id, m.roomId, m.userId, m.text, m.createdAt]);
      io.to(`room:${roomId}`).emit('room:message', { ...m, author: publicUser(user) });
    } catch (e) { logError(e, 'socket room:message'); }
  });
  socket.on('voice:join', async payload => {
    try {
      const decoded = decodeSocketToken(payload?.token);
      const roomId = cleanText(payload?.roomId, 40);
      if (!decoded || !roomId) return socket.emit('voice:error', { error: 'يلزم تسجيل الدخول' });
      if (!(await roomExists(roomId))) return socket.emit('voice:error', { error: 'الساحة غير موجودة' });
      const user = await getUserById(decoded.id);
      if (!user) return;
      if (user.status !== 'active') return socket.emit('voice:error', { error: 'حسابك موقوف مؤقتًا' });
      if (!voiceRooms.has(roomId)) voiceRooms.set(roomId, new Set());
      const set = voiceRooms.get(roomId);
      const peers = [...set];
      set.add(socket.id);
      socket.join(`voice:${roomId}`);
      socket.emit('voice:peers', { roomId, peers });
      socket.to(`voice:${roomId}`).emit('voice:user-joined', { socketId: socket.id, user: publicUser(user) });
      io.to(`room:${roomId}`).emit('voice:count', { roomId, count: set.size });
    } catch (e) { logError(e, 'socket voice:join'); }
  });
  socket.on('voice:leave', payload => {
    const roomId = cleanText(payload?.roomId, 40);
    const set = voiceRooms.get(roomId);
    if (!set) return;
    set.delete(socket.id);
    socket.leave(`voice:${roomId}`);
    socket.to(`voice:${roomId}`).emit('voice:user-left', { socketId: socket.id });
    if (!set.size) voiceRooms.delete(roomId);
    io.to(`room:${roomId}`).emit('voice:count', { roomId, count: set.size });
  });
  socket.on('rtc:offer', p => p?.to && io.to(p.to).emit('rtc:offer', { from: socket.id, sdp: p.sdp, kind: p.kind, roomId: p.roomId }));
  socket.on('rtc:answer', p => p?.to && io.to(p.to).emit('rtc:answer', { from: socket.id, sdp: p.sdp, kind: p.kind, roomId: p.roomId }));
  socket.on('rtc:ice', p => p?.to && io.to(p.to).emit('rtc:ice', { from: socket.id, candidate: p.candidate, kind: p.kind, roomId: p.roomId }));
  socket.on('live:start', async payload => {
    try {
      const decoded = decodeSocketToken(payload?.token);
      const roomId = cleanText(payload?.roomId, 40);
      if (!decoded || !roomId) return socket.emit('live:error', { error: 'يلزم تسجيل الدخول' });
      if (!(await roomExists(roomId))) return socket.emit('live:error', { error: 'الساحة غير موجودة' });
      if (liveByRoom.has(roomId)) return socket.emit('live:error', { error: 'يوجد بث مباشر قائم في هذه الساحة' });
      const user = await getUserById(decoded.id);
      if (!user) return;
      if (user.status !== 'active') return socket.emit('live:error', { error: 'حسابك موقوف مؤقتًا' });
      const live = { roomId, hostSocketId: socket.id, userId: user.id, displayName: user.displayName || user.username, startedAt: now() };
      liveByRoom.set(roomId, live);
      socket.join(`room:${roomId}`);
      socket.join(`live:${roomId}`);
      io.to(`room:${roomId}`).emit('live:started', { active: true, ...live });
    } catch (e) { logError(e, 'socket live:start'); }
  });
  socket.on('live:watch', payload => {
    const roomId = cleanText(payload?.roomId, 40);
    const live = liveByRoom.get(roomId);
    if (!live) return socket.emit('live:status', { active: false, roomId });
    socket.join(`live:${roomId}`);
    io.to(live.hostSocketId).emit('live:viewer', { viewerSocketId: socket.id, roomId });
    socket.emit('live:status', { active: true, ...live });
  });
  socket.on('live:unwatch', payload => {
    const roomId = cleanText(payload?.roomId, 40);
    const live = liveByRoom.get(roomId);
    socket.leave(`live:${roomId}`);
    if (live) io.to(live.hostSocketId).emit('live:viewer-left', { viewerSocketId: socket.id, roomId });
  });
  socket.on('live:stop', payload => {
    const roomId = cleanText(payload?.roomId, 40);
    const live = liveByRoom.get(roomId);
    if (!live || live.hostSocketId !== socket.id) return;
    liveByRoom.delete(roomId);
    io.to(`room:${roomId}`).emit('live:ended', { roomId });
  });
  socket.on('live:force-stop', async payload => {
    try {
      const decoded = decodeSocketToken(payload?.token);
      const roomId = cleanText(payload?.roomId, 40);
      if (!decoded || !roomId) return socket.emit('live:error', { error: 'يلزم تسجيل الدخول' });
      if (!(await userIsAdmin(decoded.id))) return socket.emit('live:error', { error: 'هذه الصلاحية للمدير فقط' });
      const live = liveByRoom.get(roomId);
      if (!live) return socket.emit('live:status', { active: false, roomId });
      liveByRoom.delete(roomId);
      io.to(live.hostSocketId).emit('live:force-ended', { roomId, reason: 'تم قطع البث من الإدارة' });
      io.to(`room:${roomId}`).emit('live:ended', { roomId, forced: true });
    } catch (e) { logError(e, 'socket live:force-stop'); }
  });
  socket.on('disconnect', () => removeSocketFromRtc(socket));
});

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
