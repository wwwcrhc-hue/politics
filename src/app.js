'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');
const { createPool, createInitDb } = require('./config/database');
const { env } = require('./config/env');
const { createUpload, createDeleteUploadUrl } = require('./config/upload');
const { createAuthMiddleware } = require('./middleware/auth');
const { createErrorHandler } = require('./middleware/errorHandler');
const { securityHeaders } = require('./middleware/security');
const { createAdminRouter } = require('./routes/adminRoutes');
const { createAuthRouter } = require('./routes/authRoutes');
const { createChatRouter } = require('./routes/chatRoutes');
const { createHealthRouter } = require('./routes/healthRoutes');
const { createPostsRouter } = require('./routes/postsRoutes');
const { createReportsRouter } = require('./routes/reportsRoutes');
const { createRoomsRouter } = require('./routes/roomsRoutes');
const { createSharedRepository } = require('./repositories/sharedRepository');
const { createRealtimeService } = require('./services/realtimeService');
const { createRoomPermissionsService } = require('./services/roomPermissionsService');
const { makeId } = require('./utils/id');
const { createMappers } = require('./utils/mappers');
const { cleanText } = require('./utils/text');
const { now, rowTime } = require('./utils/time');

for (const dir of [env.PUBLIC_DIR, env.UPLOAD_DIR, env.LOG_DIR]) fs.mkdirSync(dir, { recursive: true });

const pool = createPool(env.DATABASE_URL);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 2e6,
  pingTimeout: 20000,
  pingInterval: 25000
});

function logError(error, context = '') {
  try { fs.appendFileSync(env.ERROR_LOG, `[${now()}] ${context}\n${error?.stack || error}\n\n`, 'utf8'); } catch {}
}
const { publicUser, userFromRow, commentFromRow, messageFromRow, postView } = createMappers({ rowTime });
const sharedRepository = createSharedRepository({ pool, userFromRow });
const roomPermissions = createRoomPermissionsService({ sharedRepository });

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, env.JWT_SECRET, { expiresIn: '30d' });
}

const initDb = createInitDb({ pool, databaseUrl: env.DATABASE_URL, schemaFile: env.SCHEMA_FILE });
const getUserById = sharedRepository.getUserById;
const roomExists = sharedRepository.roomExists;
const getRoomById = sharedRepository.getRoomById;
const getRoomMembership = sharedRepository.getRoomMembership;
const userIsAdmin = roomPermissions.userIsAdmin;
const canManageRoom = roomPermissions.canManageRoom;
const roomPower = roomPermissions.roomPower;
const canModerateRoom = roomPermissions.canModerateRoom;

async function logModeration(actorUserId, action, targetType, targetId, roomId = null, details = {}) {
  try {
    await sharedRepository.logModeration({ id: makeId('mod'), actorUserId, action, targetType, targetId, roomId, details, createdAt: now() });
  } catch (e) { logError(e, 'logModeration'); }
}
async function getPostForViewer(postId, viewerId = '') {
  const row = await sharedRepository.getPostForViewer(postId, viewerId);
  return row ? postView(row) : null;
}

const { auth, requireAdmin, requireActiveUser, decodeSocketToken } = createAuthMiddleware({ jwt, jwtSecret: env.JWT_SECRET, getUserById });
const upload = createUpload({ uploadDir: env.UPLOAD_DIR });
const deleteUploadUrl = createDeleteUploadUrl({ uploadDir: env.UPLOAD_DIR });

const realtime = createRealtimeService({ io, pool, cleanText, decodeSocketToken, getUserById, getRoomById, roomPower, publicUser, makeId, now, logError, logModeration });

app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use('/uploads', express.static(env.UPLOAD_DIR, { fallthrough: false, maxAge: '1h', setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.use(express.static(env.PUBLIC_DIR, { maxAge: 0 }));

app.use('/api/health', createHealthRouter({ pool, appName: env.APP_NAME, version: env.VERSION, now, getPort: () => server.address()?.port || null }));

app.post('/api/live/:roomId/topic-media', auth, requireActiveUser, upload.single('media'), async (req, res, next) => {
  try {
    const roomId = cleanText(req.params.roomId, 40);
    const room = await getRoomById(roomId);
    const live = realtime.liveByRoom.get(roomId);
    if (!room || !live) {
      if (req.file) deleteUploadUrl(`/uploads/${req.file.filename}`);
      return res.status(404).json({ error: 'لا يوجد بث مباشر في هذه الساحة' });
    }
    if (live.hostUserId !== req.fullUser.id) {
      if (req.file) deleteUploadUrl(`/uploads/${req.file.filename}`);
      return res.status(403).json({ error: 'صاحب البث فقط يستطيع تغيير موضوع الحوار' });
    }
    if (!req.file) return res.status(400).json({ error: 'اختر صورة أو فيديو لعرضه في البث' });
    const uploadedTitle = cleanText(req.body?.title, 120);
    if (uploadedTitle) live.topicTitle = uploadedTitle;
    const previous = live.topicMedia;
    const media = { url: `/uploads/${req.file.filename}`, type: req.file.mimetype.startsWith('image/') ? 'image' : 'video', mime: req.file.mimetype, name: cleanText(req.file.originalname, 120), size: req.file.size };
    live.topicMedia = media;
    live.topicPlayback = { playing: true, muted: false };
    if (previous?.url) deleteUploadUrl(previous.url);
    io.to(`live:${roomId}`).emit('live:topic-media', { roomId, media });
    io.to(`live:${roomId}`).emit('live:title', { roomId, title: live.topicTitle || '' });
    io.to(`room:${roomId}`).emit('live:status', realtime.livePublic(live));
    io.emit('rooms:live-status', { roomId, active: true, live: realtime.livePublic(live) });
    res.json({ ok: true, media });
  } catch (e) { next(e); }
});

app.delete('/api/live/:roomId/topic-media', auth, requireActiveUser, async (req, res, next) => {
  try {
    const roomId = cleanText(req.params.roomId, 40);
    const live = realtime.liveByRoom.get(roomId);
    if (!live) return res.status(404).json({ error: 'لا يوجد بث مباشر في هذه الساحة' });
    if (live.hostUserId !== req.fullUser.id) return res.status(403).json({ error: 'صاحب البث فقط يستطيع تغيير موضوع الحوار' });
    const previous = live.topicMedia;
    live.topicMedia = null;
    if (previous?.url) deleteUploadUrl(previous.url);
    io.to(`live:${roomId}`).emit('live:topic-media', { roomId, media: null });
    io.to(`room:${roomId}`).emit('live:status', realtime.livePublic(live));
    io.emit('rooms:live-status', { roomId, active: true, live: realtime.livePublic(live) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.use('/api/rooms', createRoomsRouter({ pool, io, auth, requireActiveUser, cleanText, makeId, now, rowTime, publicUser, userFromRow, getRoomById, canManageRoom, roomPower, canModerateRoom, getRoomMembership, logModeration, deleteUploadUrl, getLiveByRoom: () => realtime.liveByRoom, livePublic: realtime.livePublic }));

app.use('/api', createAuthRouter({ pool, bcrypt, cleanText, makeId, now, signToken, publicUser, userFromRow, auth, requireActiveUser }));

app.post('/api/me/avatar', auth, requireActiveUser, upload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر صورة للبروفايل' });
    if (!req.file.mimetype.startsWith('image/')) {
      deleteUploadUrl(`/uploads/${req.file.filename}`);
      return res.status(400).json({ error: 'صورة البروفايل يجب أن تكون صورة' });
    }
    const user = await getUserById(req.user.id);
    const avatarUrl = `/uploads/${req.file.filename}`;
    await pool.query('update users set avatar_url = $1 where id = $2', [avatarUrl, req.user.id]);
    if (user?.avatarUrl) deleteUploadUrl(user.avatarUrl);
    res.json(publicUser(await getUserById(req.user.id)));
  } catch (e) { next(e); }
});

app.get('/api/users/:id/profile', async (req, res, next) => {
  try {
    const user = publicUser(await getUserById(cleanText(req.params.id, 80)));
    if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(user);
  } catch (e) { next(e); }
});

app.get('/api/users/:id/posts', async (req, res, next) => {
  try {
    const userId = cleanText(req.params.id, 80);
    const viewerId = '';
    const { rows } = await pool.query(`
      select p.*, u.username, u.display_name, u.bio, u.avatar_url, u.role, u.created_at as user_created_at,
        count(distinct l.id) as likes_count,
        count(distinct c.id) as comments_count,
        bool_or(case when l.user_id = $1 then true else false end) as liked_by_me
      from posts p
      join users u on u.id = p.user_id
      left join likes l on l.post_id = p.id
      left join comments c on c.post_id = p.id
      where p.user_id = $2
      group by p.id, u.id
      order by p.created_at desc
      limit 250
    `, [viewerId, userId]);
    res.json(rows.map(postView));
  } catch (e) { next(e); }
});

async function notifyUser(userId, actorUserId, type, text, data = {}) {
  if (!userId || userId === actorUserId) return;
  await pool.query(
    'insert into notifications (id,user_id,actor_user_id,type,text,data,created_at) values ($1,$2,$3,$4,$5,$6::jsonb,$7)',
    [makeId('n'), userId, actorUserId || null, type, text, JSON.stringify(data || {}), now()]
  );
}

async function socialSummaryFor(viewerId, targetId) {
  const [{ rows: followRows }, { rows: requestRows }, { rows: countRows }] = await Promise.all([
    pool.query('select 1 from follows where follower_id = $1 and following_id = $2', [viewerId, targetId]),
    pool.query(`select * from message_requests
      where (from_user_id = $1 and to_user_id = $2) or (from_user_id = $2 and to_user_id = $1)
      order by created_at desc limit 1`, [viewerId, targetId]),
    pool.query(`select
      (select count(*) from follows where following_id = $1) as followers,
      (select count(*) from follows where follower_id = $1) as following`, [targetId])
  ]);
  return {
    following: followRows.length > 0,
    messageRequest: requestRows[0] || null,
    followers: Number(countRows[0]?.followers || 0),
    followingCount: Number(countRows[0]?.following || 0)
  };
}

app.get('/api/users/:id/social', auth, requireActiveUser, async (req, res, next) => {
  try {
    const targetId = cleanText(req.params.id, 80);
    if (!await getUserById(targetId)) return res.status(404).json({ error: 'المستخدم غير موجود' });
    res.json(await socialSummaryFor(req.user.id, targetId));
  } catch (e) { next(e); }
});

app.post('/api/users/:id/follow', auth, requireActiveUser, async (req, res, next) => {
  try {
    const targetId = cleanText(req.params.id, 80);
    if (targetId === req.user.id) return res.status(400).json({ error: 'لا يمكنك متابعة نفسك' });
    const target = await getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const existing = await pool.query('select 1 from follows where follower_id = $1 and following_id = $2', [req.user.id, targetId]);
    if (existing.rowCount) {
      await pool.query('delete from follows where follower_id = $1 and following_id = $2', [req.user.id, targetId]);
      return res.json({ following: false, ...(await socialSummaryFor(req.user.id, targetId)) });
    }
    await pool.query('insert into follows (id,follower_id,following_id,created_at) values ($1,$2,$3,$4) on conflict (follower_id, following_id) do nothing', [makeId('f'), req.user.id, targetId, now()]);
    await notifyUser(targetId, req.user.id, 'follow', `${req.fullUser.displayName || req.fullUser.username} بدأ بمتابعتك`, { userId: req.user.id });
    res.json({ following: true, ...(await socialSummaryFor(req.user.id, targetId)) });
  } catch (e) { next(e); }
});

app.get('/api/me/social', auth, requireActiveUser, async (req, res, next) => {
  try {
    const [followers, following, requests, notifications] = await Promise.all([
      pool.query(`select f.created_at, u.id, u.username, u.display_name, u.bio, u.avatar_url, u.role, u.status, u.created_at as user_created_at
        from follows f join users u on u.id = f.follower_id where f.following_id = $1 order by f.created_at desc limit 80`, [req.user.id]),
      pool.query(`select f.created_at, u.id, u.username, u.display_name, u.bio, u.avatar_url, u.role, u.status, u.created_at as user_created_at
        from follows f join users u on u.id = f.following_id where f.follower_id = $1 order by f.created_at desc limit 80`, [req.user.id]),
      pool.query(`select mr.*, u.username, u.display_name, u.bio, u.avatar_url, u.role, u.status, u.created_at as user_created_at
        from message_requests mr join users u on u.id = mr.from_user_id
        where mr.to_user_id = $1 and mr.status = 'pending' order by mr.created_at desc limit 80`, [req.user.id]),
      pool.query(`select n.*, u.username, u.display_name, u.bio, u.avatar_url, u.role, u.status, u.created_at as user_created_at
        from notifications n left join users u on u.id = n.actor_user_id
        where n.user_id = $1 order by n.created_at desc limit 80`, [req.user.id])
    ]);
    res.json({
      followers: followers.rows.map(r => ({ ...publicUser(userFromRow(r)), followedAt: rowTime(r.created_at) })),
      following: following.rows.map(r => ({ ...publicUser(userFromRow(r)), followedAt: rowTime(r.created_at) })),
      requests: requests.rows.map(r => ({ id:r.id, fromUserId:r.from_user_id, user:publicUser(userFromRow(r)), createdAt:rowTime(r.created_at) })),
      notifications: notifications.rows.map(r => ({ id:r.id, type:r.type, text:r.text, data:r.data || {}, readAt:rowTime(r.read_at), createdAt:rowTime(r.created_at), actor:publicUser(userFromRow(r)) }))
    });
  } catch (e) { next(e); }
});

app.post('/api/notifications/read', auth, requireActiveUser, async (req, res, next) => {
  try {
    await pool.query('update notifications set read_at = coalesce(read_at, $2) where user_id = $1', [req.user.id, now()]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/users/:id/message-request', auth, requireActiveUser, async (req, res, next) => {
  try {
    const targetId = cleanText(req.params.id, 80);
    if (targetId === req.user.id) return res.status(400).json({ error: 'لا يمكنك مراسلة نفسك' });
    const target = await getUserById(targetId);
    if (!target) return res.status(404).json({ error: 'المستخدم غير موجود' });
    const { rows } = await pool.query(`insert into message_requests (id,from_user_id,to_user_id,status,created_at,updated_at)
      values ($1,$2,$3,'pending',$4,$4)
      on conflict (from_user_id, to_user_id) do update set status = 'pending', updated_at = excluded.updated_at
      returning *`, [makeId('mr'), req.user.id, targetId, now()]);
    await notifyUser(targetId, req.user.id, 'message_request', `${req.fullUser.displayName || req.fullUser.username} طلب مراسلتك`, { requestId: rows[0].id, userId: req.user.id });
    res.json({ ok: true, request: rows[0] });
  } catch (e) { next(e); }
});

app.post('/api/message-requests/:id/respond', auth, requireActiveUser, async (req, res, next) => {
  try {
    const status = req.body?.accept ? 'accepted' : 'rejected';
    const { rows } = await pool.query(`update message_requests set status = $1, updated_at = $2
      where id = $3 and to_user_id = $4 returning *`, [status, now(), cleanText(req.params.id, 80), req.user.id]);
    const request = rows[0];
    if (!request) return res.status(404).json({ error: 'طلب المراسلة غير موجود' });
    await notifyUser(request.from_user_id, req.user.id, `message_${status}`, `${req.fullUser.displayName || req.fullUser.username} ${status === 'accepted' ? 'قبل' : 'رفض'} طلب المراسلة`, { userId: req.user.id });
    res.json({ ok: true, request });
  } catch (e) { next(e); }
});

async function canMessage(userA, userB) {
  const { rowCount } = await pool.query(`select 1 from message_requests
    where status = 'accepted' and ((from_user_id = $1 and to_user_id = $2) or (from_user_id = $2 and to_user_id = $1))`, [userA, userB]);
  return rowCount > 0;
}

app.get('/api/messages/:userId', auth, requireActiveUser, async (req, res, next) => {
  try {
    const otherId = cleanText(req.params.userId, 80);
    if (!await canMessage(req.user.id, otherId)) return res.status(403).json({ error: 'يجب قبول طلب المراسلة أولاً' });
    const { rows } = await pool.query(`select dm.*, u.username, u.display_name, u.bio, u.avatar_url, u.role, u.status, u.created_at as user_created_at
      from direct_messages dm join users u on u.id = dm.from_user_id
      where (dm.from_user_id = $1 and dm.to_user_id = $2) or (dm.from_user_id = $2 and dm.to_user_id = $1)
      order by dm.created_at asc limit 250`, [req.user.id, otherId]);
    res.json(rows.map(r => ({ id:r.id, fromUserId:r.from_user_id, toUserId:r.to_user_id, text:r.text, createdAt:rowTime(r.created_at), author:publicUser(userFromRow(r)) })));
  } catch (e) { next(e); }
});

app.post('/api/messages/:userId', auth, requireActiveUser, async (req, res, next) => {
  try {
    const otherId = cleanText(req.params.userId, 80);
    const text = cleanText(req.body?.text, 1500);
    if (!text) return res.status(400).json({ error: 'اكتب رسالة أولاً' });
    if (!await canMessage(req.user.id, otherId)) return res.status(403).json({ error: 'يجب قبول طلب المراسلة أولاً' });
    const { rows } = await pool.query(`insert into direct_messages (id,from_user_id,to_user_id,text,created_at)
      values ($1,$2,$3,$4,$5) returning *`, [makeId('dm'), req.user.id, otherId, text, now()]);
    await notifyUser(otherId, req.user.id, 'direct_message', `${req.fullUser.displayName || req.fullUser.username} أرسل لك رسالة`, { userId: req.user.id });
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

app.use('/api', createPostsRouter({ pool, io, auth, requireActiveUser, upload, cleanText, makeId, now, postView, getPostForViewer, roomExists, getRoomById, userIsAdmin, canModerateRoom, commentFromRow, userFromRow, publicUser, getUserById, deleteUploadUrl }));

app.use('/api', createReportsRouter({ pool, auth, requireActiveUser, requireAdmin, cleanText, makeId, now, rowTime, logModeration }));

app.use('/api', createChatRouter({ pool, io, auth, requireActiveUser, getRoomById, canModerateRoom, messageFromRow, userFromRow, publicUser }));

app.use('/api/admin', createAdminRouter({ pool, auth, requireAdmin, cleanText, rowTime, userFromRow, publicUser, getLiveByRoom: () => realtime.liveByRoom, getVoiceRooms: () => realtime.voiceRooms, livePublic: realtime.livePublic }));

realtime.registerHandlers();

app.get('/admin', (_req, res, next) => res.sendFile(`${env.PUBLIC_DIR}/admin.html`, e => e && next(e)));
app.get('/', (_req, res, next) => res.sendFile(`${env.PUBLIC_DIR}/index.html`, e => e && next(e)));
app.use('/api', (_req, res) => res.status(404).json({ error: 'واجهة API غير موجودة' }));
app.get('*', (_req, res, next) => res.sendFile(`${env.PUBLIC_DIR}/index.html`, e => e && next(e)));
app.use(createErrorHandler({ multer, logError }));

function startServer(port = env.START_PORT, attempt = 0) {
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
    console.log(`\n${env.APP_NAME} ${env.VERSION}\nhttp://localhost:${actual}\nفحص: http://localhost:${actual}/api/health\n`);
  };
  server.once('error', onError);
  server.once('listening', onListening);
    server.listen(port, env.HOST);
}

function shutdown(done = () => process.exit(0)) {
  io.close(() => server.close(() => pool.end(done)));
}

module.exports = { app, server, io, pool, initDb, startServer, shutdown, logError };
