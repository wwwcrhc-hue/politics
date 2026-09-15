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
const { createHealthRouter } = require('./src/routes/healthRoutes');

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

app.get('/api/rooms', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`
      select r.id, r.name, r.description, r.owner_user_id, r.status, r.created_at,
        u.id as user_id,
        u.username, u.display_name, u.bio, u.role, u.created_at as user_created_at,
        count(distinct p.id) as posts,
        count(distinct m.id) as messages
      from rooms r
      left join users u on u.id = r.owner_user_id
      left join posts p on p.room_id = r.id
      left join room_messages m on m.room_id = r.id
      group by r.id, u.id
      order by case when r.owner_user_id is null then 0 else 1 end, r.created_at asc, r.id asc
    `);
    res.json(rows.map(r => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status || 'active',
      ownerUserId: r.owner_user_id || null,
      owner: r.owner_user_id ? publicUser(userFromRow(r)) : null,
      createdAt: rowTime(r.created_at),
      posts: Number(r.posts),
      messages: Number(r.messages)
    })));
  } catch (e) { next(e); }
});

app.post('/api/rooms', auth, requireActiveUser, async (req, res, next) => {
  try {
    const name = cleanText(req.body.name, 60);
    const description = cleanText(req.body.description, 240);
    if (name.length < 3) return res.status(400).json({ error: 'اسم الغرفة يجب أن يكون 3 أحرف على الأقل' });
    const room = { id: makeId('room'), name, description, ownerUserId: req.user.id, createdAt: now() };
    await pool.query(
      'insert into rooms (id, name, description, owner_user_id, created_at) values ($1, $2, $3, $4, $5)',
      [room.id, room.name, room.description, room.ownerUserId, room.createdAt]
    );
    res.status(201).json({ ...room, owner: publicUser(req.fullUser), posts: 0, messages: 0 });
  } catch (e) { next(e); }
});

app.patch('/api/rooms/:id', auth, requireActiveUser, async (req, res, next) => {
  try {
    const room = await getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
    if (!(await canManageRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك إدارة هذه الغرفة' });
    const name = cleanText(req.body.name, 60);
    const description = cleanText(req.body.description, 240);
    if (name.length < 3) return res.status(400).json({ error: 'اسم الغرفة يجب أن يكون 3 أحرف على الأقل' });
    await pool.query('update rooms set name = $1, description = $2 where id = $3', [name, description, room.id]);
    io.to(`room:${room.id}`).emit('room:updated', { roomId: room.id });
    res.json({ id: room.id, name, description, ownerUserId: room.owner_user_id || null });
  } catch (e) { next(e); }
});

app.delete('/api/rooms/:id', auth, requireActiveUser, async (req, res, next) => {
  try {
    const room = await getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
    if (!(await canManageRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك حذف هذه الغرفة' });
    const posts = await pool.query('select media from posts where room_id = $1', [room.id]);
    for (const p of posts.rows) for (const m of (p.media || [])) deleteUploadUrl(m.url);
    await pool.query('delete from posts where room_id = $1', [room.id]);
    await pool.query('delete from rooms where id = $1', [room.id]);
    liveByRoom.delete(room.id);
    io.emit('room:deleted', { roomId: room.id });
    io.emit('feed:changed', { roomId: room.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/rooms/:id/permissions', auth, async (req, res, next) => {
  try {
    const room = await getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
    const power = await roomPower(req.user.id, room);
    res.json({ roomId: room.id, roomStatus: room.status || 'active', ...power, canCreatePosts: !power.banned && (room.status || 'active') === 'active' });
  } catch (e) { next(e); }
});

app.get('/api/rooms/:id/members', auth, async (req, res, next) => {
  try {
    const room = await getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
    const power = await roomPower(req.user.id, room);
    if (!power.canModerate) return res.status(403).json({ error: 'إدارة الأعضاء متاحة لمالك الغرفة ومشرفيها فقط' });
    const { rows } = await pool.query(`select rm.*, u.username, u.display_name, u.role as global_role from room_members rm join users u on u.id = rm.user_id where rm.room_id = $1 order by rm.created_at asc`, [room.id]);
    res.json(rows.map(r => ({ userId:r.user_id, username:r.username, displayName:r.display_name, role:r.role, status:r.status, globalRole:r.global_role, createdAt:rowTime(r.created_at) })));
  } catch (e) { next(e); }
});

app.post('/api/rooms/:id/members', auth, requireActiveUser, async (req, res, next) => {
  try {
    const room = await getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
    if (!(await canModerateRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك إضافة أعضاء لهذه الغرفة' });
    const username = cleanText(req.body.username, 24);
    const role = cleanText(req.body.role, 20) === 'moderator' ? 'moderator' : 'member';
    const { rows } = await pool.query('select * from users where lower(username)=lower($1)', [username]);
    const target = userFromRow(rows[0]);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    if (target.id === room.owner_user_id) return res.status(400).json({ error: 'هذا المستخدم هو مالك الغرفة بالفعل' });
    await pool.query(`insert into room_members (id,room_id,user_id,role,status,created_at) values ($1,$2,$3,$4,'active',$5) on conflict (room_id,user_id) do update set role=excluded.role,status='active'`, [makeId('rm'),room.id,target.id,role,now()]);
    await logModeration(req.user.id,'room_member_add','user',target.id,room.id,{role});
    res.status(201).json({ ok:true, user:publicUser(target), role });
  } catch (e) { next(e); }
});

app.patch('/api/rooms/:id/members/:userId', auth, requireActiveUser, async (req, res, next) => {
  try {
    const room = await getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
    if (!(await canModerateRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك إدارة أعضاء هذه الغرفة' });
    const role = ['member','moderator'].includes(req.body.role) ? req.body.role : null;
    const status = ['active','banned'].includes(req.body.status) ? req.body.status : null;
    const current = await getRoomMembership(room.id, req.params.userId);
    if (!current) return res.status(404).json({ error: 'العضو غير موجود في قائمة الغرفة' });
    await pool.query('update room_members set role=$1,status=$2 where room_id=$3 and user_id=$4',[role||current.role,status||current.status,room.id,req.params.userId]);
    if (status === 'banned') io.to(`room:${room.id}`).emit('room:user-banned',{roomId:room.id,userId:req.params.userId});
    await logModeration(req.user.id,'room_member_update','user',req.params.userId,room.id,{role,status});
    res.json({ok:true});
  } catch (e) { next(e); }
});

app.delete('/api/rooms/:id/members/:userId', auth, requireActiveUser, async (req, res, next) => {
  try {
    const room = await getRoomById(req.params.id);
    if (!room) return res.status(404).json({ error: 'الغرفة غير موجودة' });
    if (!(await canModerateRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك إزالة أعضاء هذه الغرفة' });
    await pool.query('delete from room_members where room_id=$1 and user_id=$2',[room.id,req.params.userId]);
    await logModeration(req.user.id,'room_member_remove','user',req.params.userId,room.id,{});
    res.json({ok:true});
  } catch (e) { next(e); }
});

app.patch('/api/rooms/:id/status', auth, requireActiveUser, async (req,res,next)=>{
  try{
    const room=await getRoomById(req.params.id); if(!room) return res.status(404).json({error:'الغرفة غير موجودة'});
    if(!(await canManageRoom(req.user.id,room))) return res.status(403).json({error:'إغلاق الغرفة متاح للمالك أو الإدارة فقط'});
    const status=req.body.status==='closed'?'closed':'active';
    await pool.query('update rooms set status=$1 where id=$2',[status,room.id]);
    await logModeration(req.user.id,'room_status','room',room.id,room.id,{status});
    io.to(`room:${room.id}`).emit('room:status',{roomId:room.id,status}); res.json({ok:true,status});
  }catch(e){next(e)}
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
    const room = await getRoomById(post.room_id);
    if (post.user_id !== req.user.id && !(await canModerateRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك حذف هذا المنشور' });
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
    const { rows } = await pool.query('select c.*, p.room_id, r.owner_user_id from comments c join posts p on p.id = c.post_id join rooms r on r.id = p.room_id where c.id = $1', [req.params.id]);
    const comment = rows[0];
    if (!comment) return res.status(404).json({ error: 'التعليق غير موجود' });
    const room = await getRoomById(comment.room_id);
    if (comment.user_id !== req.user.id && !(await canModerateRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك حذف هذا التعليق' });
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
    const { rows } = await pool.query(`
      select m.*, r.owner_user_id
      from room_messages m
      join rooms r on r.id = m.room_id
      where m.id = $1
    `, [req.params.id]);
    const message = rows[0];
    if (!message) return res.status(404).json({ error: 'الرسالة غير موجودة' });
    const room = await getRoomById(message.room_id);
    if (message.user_id !== req.user.id && !(await canModerateRoom(req.user.id, room))) return res.status(403).json({ error: 'لا يمكنك حذف هذه الرسالة' });
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

app.get('/api/admin/reports', auth, requireAdmin, async (_req,res,next)=>{try{const {rows}=await pool.query(`select rp.*,u.username,u.display_name from reports rp join users u on u.id=rp.reporter_id order by rp.created_at desc limit 300`);res.json(rows.map(r=>({id:r.id,targetType:r.target_type,targetId:r.target_id,reason:r.reason,status:r.status,createdAt:rowTime(r.created_at),reporter:{username:r.username,displayName:r.display_name}})))}catch(e){next(e)}});
app.patch('/api/admin/reports/:id', auth, requireAdmin, async (req,res,next)=>{try{const status=['open','reviewing','resolved','dismissed'].includes(req.body.status)?req.body.status:'reviewing';const {rows}=await pool.query('update reports set status=$1 where id=$2 returning *',[status,req.params.id]);if(!rows[0])return res.status(404).json({error:'البلاغ غير موجود'});await logModeration(req.user.id,'report_status','report',req.params.id,null,{status});res.json({ok:true,status})}catch(e){next(e)}});
app.get('/api/admin/moderation-logs', auth, requireAdmin, async (_req,res,next)=>{try{const {rows}=await pool.query(`select ml.*,u.username,u.display_name from moderation_logs ml left join users u on u.id=ml.actor_user_id order by ml.created_at desc limit 500`);res.json(rows.map(r=>({id:r.id,action:r.action,targetType:r.target_type,targetId:r.target_id,roomId:r.room_id,details:r.details||{},createdAt:rowTime(r.created_at),actor:r.actor_user_id?{username:r.username,displayName:r.display_name}:null})))}catch(e){next(e)}});
app.get('/api/admin/active-sessions', auth, requireAdmin, async (_req,res)=>{res.json({live:[...liveByRoom.values()].map(livePublic),voice:[...voiceRooms.entries()].map(([roomId,state])=>({roomId,participants:[...state.participants.values()].map(p=>({socketId:p.socketId,user:p.user,role:p.role,muted:!!p.muted}))}))})});

const voiceRooms = new Map(); // roomId -> {participants: Map, monitors: Set}
const liveByRoom = new Map(); // roomId -> live state
function livePublic(live) {
  return { active:true, roomId:live.roomId, sessionId:live.sessionId, hostSocketId:live.hostSocketId, userId:live.hostUserId, displayName:live.hostDisplayName, startedAt:live.startedAt, viewerCount:live.viewers.size, broadcasters:[...live.broadcasters.values()].map(b=>({socketId:b.socketId,userId:b.userId,displayName:b.displayName,role:b.role})) };
}
async function socketUser(socket, token) {
  const decoded=decodeSocketToken(token); if(!decoded) return null;
  const user=await getUserById(decoded.id); if(!user||user.status!=='active') return null;
  socket.data.userId=user.id; socket.data.user=user; return user;
}
function emitVoiceState(roomId) {
  const state=voiceRooms.get(roomId); const participants=state?[...state.participants.values()].map(p=>({socketId:p.socketId,user:p.user,role:p.role,muted:!!p.muted})):[];
  io.to(`voice:${roomId}`).emit('voice:participants',{roomId,participants});
  io.to(`room:${roomId}`).emit('voice:count',{roomId,count:participants.length});
}
function removeSocketFromRtc(socket) {
  for (const [roomId,state] of voiceRooms) {
    state.monitors?.delete(socket.id);
    if(state.participants.delete(socket.id)){
      socket.to(`voice:${roomId}`).emit('voice:user-left',{socketId:socket.id});
      if(!state.participants.size && !(state.monitors?.size)) voiceRooms.delete(roomId);
      emitVoiceState(roomId);
    } else if(!state.participants.size && !(state.monitors?.size)) voiceRooms.delete(roomId);
  }
  for (const [roomId,live] of liveByRoom) {
    live.viewers.delete(socket.id);
    if(live.monitors?.delete(socket.id)) for(const b of live.broadcasters.keys()) io.to(b).emit('live:viewer-left',{viewerSocketId:socket.id,roomId});
    if(socket.id===live.hostSocketId){
      liveByRoom.delete(roomId); io.to(`room:${roomId}`).emit('live:ended',{roomId,forced:false}); io.to(`live:${roomId}`).emit('live:ended',{roomId,forced:false});
    } else if(live.broadcasters.has(socket.id)) {
      live.broadcasters.delete(socket.id); io.to(`live:${roomId}`).emit('live:broadcaster-removed',{roomId,socketId:socket.id}); io.to(`room:${roomId}`).emit('live:status',livePublic(live));
    } else {
      for(const b of live.broadcasters.keys()) io.to(b).emit('live:viewer-left',{viewerSocketId:socket.id,roomId});
    }
  }
}

io.on('connection', socket => {
  socket.on('session:auth', async p=>{try{const u=await socketUser(socket,p?.token);socket.emit('session:auth-result',{ok:!!u,user:u?publicUser(u):null})}catch(e){logError(e,'session:auth')}});
  socket.on('room:join', async roomId => {try{const room=await getRoomById(cleanText(roomId,40));if(!room)return;for(const r of socket.rooms)if(String(r).startsWith('room:'))socket.leave(r);socket.join(`room:${room.id}`);const live=liveByRoom.get(room.id);socket.emit('live:status',live?livePublic(live):{active:false,roomId:room.id});if(live)io.to(live.hostSocketId).emit('live:invite-candidates-changed',{roomId:room.id});const state=voiceRooms.get(room.id);socket.emit('voice:count',{roomId:room.id,count:state?.participants.size||0});}catch(e){logError(e,'room:join')}});
  socket.on('live:status-request',p=>{const roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);socket.emit('live:status',live?livePublic(live):{active:false,roomId})});
  socket.on('room:message', async p=>{try{const user=await socketUser(socket,p?.token);const roomId=cleanText(p?.roomId,40),text=cleanText(p?.text,1000);const room=await getRoomById(roomId);if(!user||!room||!text)return;const power=await roomPower(user.id,room);if(power.banned)return socket.emit('room:error',{error:'تم حجبك من هذه الغرفة'});if((room.status||'active')!=='active')return socket.emit('room:error',{error:'الغرفة مغلقة حاليًا'});const m={id:makeId('m'),roomId,userId:user.id,text,createdAt:now()};await pool.query('insert into room_messages (id,room_id,user_id,text,created_at) values ($1,$2,$3,$4,$5)',[m.id,m.roomId,m.userId,m.text,m.createdAt]);io.to(`room:${roomId}`).emit('room:message',{...m,author:publicUser(user)})}catch(e){logError(e,'room:message')}});

  socket.on('voice:join', async p=>{try{const user=await socketUser(socket,p?.token);const roomId=cleanText(p?.roomId,40),room=await getRoomById(roomId);if(!user||!room)return socket.emit('voice:error',{error:'يلزم تسجيل الدخول'});const power=await roomPower(user.id,room);if(power.banned)return socket.emit('voice:error',{error:'تم حجبك من هذه الغرفة'});if((room.status||'active')!=='active')return socket.emit('voice:error',{error:'الغرفة مغلقة'});if(!voiceRooms.has(roomId))voiceRooms.set(roomId,{participants:new Map(),monitors:new Set()});const state=voiceRooms.get(roomId);const peers=[...state.participants.keys()];const role=power.role==='guest'?'member':power.role;state.participants.set(socket.id,{socketId:socket.id,user:publicUser(user),role,muted:false});socket.join(`voice:${roomId}`);socket.emit('voice:peers',{roomId,peers});socket.to(`voice:${roomId}`).emit('voice:user-joined',{socketId:socket.id,user:publicUser(user),role});for(const monitorId of state.monitors||[])socket.emit('voice:monitor-peer',{roomId,monitorSocketId:monitorId});emitVoiceState(roomId)}catch(e){logError(e,'voice:join')}});
  socket.on('voice:leave',p=>{const roomId=cleanText(p?.roomId,40),state=voiceRooms.get(roomId);if(!state)return;state.participants.delete(socket.id);socket.leave(`voice:${roomId}`);socket.to(`voice:${roomId}`).emit('voice:user-left',{socketId:socket.id});if(!state.participants.size && !(state.monitors?.size))voiceRooms.delete(roomId);emitVoiceState(roomId)});
  socket.on('voice:moderate', async p=>{try{const actor=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),targetSocketId=cleanText(p?.targetSocketId,80),action=cleanText(p?.action,20),room=await getRoomById(roomId),state=voiceRooms.get(roomId);if(!actor||!room||!state)return;const power=await roomPower(actor.id,room);if(!power.canModerate)return socket.emit('voice:error',{error:'ليست لديك صلاحية إدارة المتحدثين'});const target=state.participants.get(targetSocketId);if(!target)return;if(action==='mute'){target.muted=true;io.to(targetSocketId).emit('voice:force-mute',{roomId,by:actor.id});await logModeration(actor.id,'voice_mute','user',target.user.id,roomId,{})}else if(action==='kick'){state.participants.delete(targetSocketId);io.to(targetSocketId).emit('voice:kicked',{roomId,reason:'تم إخراجك من الغرفة الصوتية'});io.sockets.sockets.get(targetSocketId)?.leave(`voice:${roomId}`);io.to(`voice:${roomId}`).emit('voice:user-left',{socketId:targetSocketId});await logModeration(actor.id,'voice_kick','user',target.user.id,roomId,{})}emitVoiceState(roomId)}catch(e){logError(e,'voice:moderate')}});
  socket.on('admin:voice-monitor', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40);if(!admin||admin.role!=='admin')return;let state=voiceRooms.get(roomId);if(!state){state={participants:new Map(),monitors:new Set()};voiceRooms.set(roomId,state)}if(!state.monitors)state.monitors=new Set();state.monitors.add(socket.id);socket.data.adminVoiceMonitorRoom=roomId;for(const peerId of state.participants.keys())io.to(peerId).emit('voice:monitor-peer',{roomId,monitorSocketId:socket.id});socket.emit('admin:voice-monitor-ready',{roomId,count:state.participants.size})}catch(e){logError(e,'admin:voice-monitor')}});
  socket.on('admin:voice-unmonitor', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40);if(!admin||admin.role!=='admin')return;const state=voiceRooms.get(roomId);state?.monitors?.delete(socket.id);if(state&&!state.participants.size&&!state.monitors.size)voiceRooms.delete(roomId);socket.data.adminVoiceMonitorRoom=null}catch(e){logError(e,'admin:voice-unmonitor')}});

  socket.on('rtc:offer',p=>p?.to&&io.to(p.to).emit('rtc:offer',{from:socket.id,sdp:p.sdp,kind:p.kind,roomId:p.roomId}));
  socket.on('rtc:answer',p=>p?.to&&io.to(p.to).emit('rtc:answer',{from:socket.id,sdp:p.sdp,kind:p.kind,roomId:p.roomId}));
  socket.on('rtc:ice',p=>p?.to&&io.to(p.to).emit('rtc:ice',{from:socket.id,candidate:p.candidate,kind:p.kind,roomId:p.roomId}));

  socket.on('live:start', async p=>{try{const user=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),room=await getRoomById(roomId);if(!user||!room)return socket.emit('live:error',{error:'يلزم تسجيل الدخول'});const power=await roomPower(user.id,room);if(power.banned)return socket.emit('live:error',{error:'تم حجبك من الغرفة'});if((room.status||'active')!=='active')return socket.emit('live:error',{error:'الغرفة مغلقة'});if(liveByRoom.has(roomId))return socket.emit('live:error',{error:'يوجد بث مباشر قائم في هذه الغرفة'});const live={roomId,sessionId:makeId('live'),hostSocketId:socket.id,hostUserId:user.id,hostDisplayName:user.displayName||user.username,startedAt:now(),broadcasters:new Map(),viewers:new Set(),monitors:new Set(),invitedUsers:new Set()};live.broadcasters.set(socket.id,{socketId:socket.id,userId:user.id,displayName:user.displayName||user.username,role:'host'});liveByRoom.set(roomId,live);socket.join(`room:${roomId}`);socket.join(`live:${roomId}`);io.to(`room:${roomId}`).emit('live:started',livePublic(live));io.to(`live:${roomId}`).emit('live:status',livePublic(live))}catch(e){logError(e,'live:start')}});
  socket.on('live:watch',p=>{const roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!live)return socket.emit('live:status',{active:false,roomId});live.viewers.add(socket.id);socket.join(`live:${roomId}`);for(const broadcasterSocket of live.broadcasters.keys())if(broadcasterSocket!==socket.id)io.to(broadcasterSocket).emit('live:viewer',{viewerSocketId:socket.id,roomId});socket.emit('live:status',livePublic(live))});
  socket.on('live:unwatch',p=>{const roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);socket.leave(`live:${roomId}`);if(live){live.viewers.delete(socket.id);for(const b of live.broadcasters.keys())io.to(b).emit('live:viewer-left',{viewerSocketId:socket.id,roomId})}});
  socket.on('live:invite-candidates', async p=>{try{const actor=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!actor||!live||live.hostUserId!==actor.id)return socket.emit('live:invite-candidates',{roomId,users:[]});const broadcasterUsers=new Set([...live.broadcasters.values()].map(b=>b.userId));const users=new Map();for(const s of io.sockets.sockets.values()){const user=s.data.user;if(!user||user.id===actor.id||broadcasterUsers.has(user.id)||!s.rooms.has(`room:${roomId}`))continue;users.set(user.id,publicUser(user));}socket.emit('live:invite-candidates',{roomId,users:[...users.values()]})}catch(e){logError(e,'live:invite-candidates')}});
  socket.on('live:invite', async p=>{try{const actor=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!actor||!live||live.hostUserId!==actor.id)return socket.emit('live:error',{error:'صاحب البث فقط يستطيع دعوة ضيف'});let targetUserId=cleanText(p?.targetUserId,80);if(!targetUserId&&p?.username){const {rows}=await pool.query('select * from users where lower(username)=lower($1)',[cleanText(p.username,24)]);targetUserId=rows[0]?.id||'';}if(!targetUserId)return socket.emit('live:error',{error:'المستخدم غير موجود'});if(targetUserId===actor.id)return socket.emit('live:error',{error:'أنت بالفعل صاحب البث'});live.invitedUsers.add(targetUserId);let sent=false;for(const s of io.sockets.sockets.values())if(s.data.userId===targetUserId&&s.rooms.has(`room:${roomId}`)){s.emit('live:invite',{roomId,sessionId:live.sessionId,from:{userId:actor.id,displayName:actor.displayName||actor.username}});sent=true}socket.emit('live:invite-result',{ok:sent,targetUserId});await logModeration(actor.id,'live_invite','user',targetUserId,roomId,{sessionId:live.sessionId})}catch(e){logError(e,'live:invite')}});
  socket.on('live:guest-accept', async p=>{try{const user=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!user||!live||!live.invitedUsers.has(user.id))return socket.emit('live:error',{error:'لا توجد دعوة صالحة لهذا البث'});live.invitedUsers.delete(user.id);live.broadcasters.set(socket.id,{socketId:socket.id,userId:user.id,displayName:user.displayName||user.username,role:'guest'});socket.join(`live:${roomId}`);for(const viewer of [...live.viewers,...(live.monitors||[])])if(viewer!==socket.id)io.to(socket.id).emit('live:viewer',{viewerSocketId:viewer,roomId});for(const [otherId,other] of live.broadcasters)if(otherId!==socket.id&&other.role==='host'){io.to(otherId).emit('live:viewer',{viewerSocketId:socket.id,roomId})}io.to(`live:${roomId}`).emit('live:broadcaster-added',{roomId,broadcaster:{socketId:socket.id,userId:user.id,displayName:user.displayName||user.username,role:'guest'}});io.to(`room:${roomId}`).emit('live:status',livePublic(live))}catch(e){logError(e,'live:guest-accept')}});
  socket.on('live:guest-leave', async p=>{try{const user=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!user||!live)return;const target=live.broadcasters.get(socket.id);if(!target||target.role!=='guest')return;live.broadcasters.delete(socket.id);socket.leave(`live:${roomId}`);io.to(`live:${roomId}`).emit('live:broadcaster-removed',{roomId,socketId:socket.id});for(const b of live.broadcasters.keys())io.to(b).emit('live:viewer-left',{viewerSocketId:socket.id,roomId});io.to(`room:${roomId}`).emit('live:status',livePublic(live))}catch(e){logError(e,'live:guest-leave')}});
  socket.on('live:guest-remove', async p=>{try{const actor=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),targetSocketId=cleanText(p?.targetSocketId,80),live=liveByRoom.get(roomId);if(!actor||!live||live.hostUserId!==actor.id)return;const target=live.broadcasters.get(targetSocketId);if(!target||target.role==='host')return;live.broadcasters.delete(targetSocketId);io.to(targetSocketId).emit('live:guest-removed',{roomId,reason:'أنهى صاحب البث مشاركتك'});io.to(`live:${roomId}`).emit('live:broadcaster-removed',{roomId,socketId:targetSocketId});await logModeration(actor.id,'live_guest_remove','user',target.userId,roomId,{sessionId:live.sessionId});io.to(`room:${roomId}`).emit('live:status',livePublic(live))}catch(e){logError(e,'live:guest-remove')}});
  socket.on('live:broadcaster-mute', async p=>{try{const actor=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),targetSocketId=cleanText(p?.targetSocketId,80),live=liveByRoom.get(roomId);if(!actor||!live||live.hostUserId!==actor.id)return;const target=live.broadcasters.get(targetSocketId);if(!target||target.role==='host')return;io.to(targetSocketId).emit('live:force-mute',{roomId,reason:'تم كتم صوتك بواسطة مضيف البث'});await logModeration(actor.id,'live_guest_mute','user',target.userId,roomId,{sessionId:live.sessionId})}catch(e){logError(e,'live:broadcaster-mute')}});
  socket.on('live:stop',p=>{const roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!live||live.hostSocketId!==socket.id)return;liveByRoom.delete(roomId);io.to(`room:${roomId}`).emit('live:ended',{roomId});io.to(`live:${roomId}`).emit('live:ended',{roomId})});

  socket.on('admin:live-monitor', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!admin||admin.role!=='admin'||!live)return socket.emit('admin:live-monitor-ready',{roomId,active:false});if(!live.monitors)live.monitors=new Set();live.monitors.add(socket.id);socket.data.adminLiveMonitorRoom=roomId;for(const broadcasterSocket of live.broadcasters.keys())if(broadcasterSocket!==socket.id)io.to(broadcasterSocket).emit('live:viewer',{viewerSocketId:socket.id,roomId});socket.emit('admin:live-monitor-ready',{roomId,active:true,broadcasters:livePublic(live).broadcasters})}catch(e){logError(e,'admin:live-monitor')}});
  socket.on('admin:live-unmonitor', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),live=liveByRoom.get(roomId);if(!admin||admin.role!=='admin')return;if(live?.monitors?.delete(socket.id))for(const b of live.broadcasters.keys())io.to(b).emit('live:viewer-left',{viewerSocketId:socket.id,roomId});socket.data.adminLiveMonitorRoom=null}catch(e){logError(e,'admin:live-unmonitor')}});
  socket.on('admin:live-stop', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40);if(!admin||admin.role!=='admin')return;const live=liveByRoom.get(roomId);if(!live)return;liveByRoom.delete(roomId);io.to(`live:${roomId}`).emit('live:force-ended',{roomId,reason:'انتهى البث المباشر'});io.to(`room:${roomId}`).emit('live:ended',{roomId,forced:true});await logModeration(admin.id,'admin_live_stop','live',live.sessionId,roomId,{})}catch(e){logError(e,'admin:live-stop')}});
  socket.on('admin:live-guest-remove', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),targetSocketId=cleanText(p?.targetSocketId,80);if(!admin||admin.role!=='admin')return;const live=liveByRoom.get(roomId),target=live?.broadcasters.get(targetSocketId);if(!live||!target||target.role==='host')return;live.broadcasters.delete(targetSocketId);io.to(targetSocketId).emit('live:guest-removed',{roomId,reason:'تم إنهاء مشاركتك'});io.to(`live:${roomId}`).emit('live:broadcaster-removed',{roomId,socketId:targetSocketId});io.to(`room:${roomId}`).emit('live:status',livePublic(live));await logModeration(admin.id,'admin_live_guest_remove','user',target.userId,roomId,{sessionId:live.sessionId})}catch(e){logError(e,'admin:live-guest-remove')}});
  socket.on('admin:voice-kick', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),targetSocketId=cleanText(p?.targetSocketId,80);if(!admin||admin.role!=='admin')return;const state=voiceRooms.get(roomId),target=state?.participants.get(targetSocketId);if(!target)return;state.participants.delete(targetSocketId);io.to(targetSocketId).emit('voice:kicked',{roomId,reason:'تم إخراجك من الغرفة الصوتية'});io.sockets.sockets.get(targetSocketId)?.leave(`voice:${roomId}`);emitVoiceState(roomId);await logModeration(admin.id,'admin_voice_kick','user',target.user.id,roomId,{})}catch(e){logError(e,'admin:voice-kick')}});
  socket.on('admin:voice-mute', async p=>{try{const admin=await socketUser(socket,p?.token),roomId=cleanText(p?.roomId,40),targetSocketId=cleanText(p?.targetSocketId,80);if(!admin||admin.role!=='admin')return;const state=voiceRooms.get(roomId),target=state?.participants.get(targetSocketId);if(!target)return;target.muted=true;io.to(targetSocketId).emit('voice:force-mute',{roomId,by:'admin'});emitVoiceState(roomId);await logModeration(admin.id,'admin_voice_mute','user',target.user.id,roomId,{})}catch(e){logError(e,'admin:voice-mute')}});
  socket.on('disconnect',()=>removeSocketFromRtc(socket));
});

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
