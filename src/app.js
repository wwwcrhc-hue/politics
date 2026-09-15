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

app.use('/api/rooms', createRoomsRouter({ pool, io, auth, requireActiveUser, cleanText, makeId, now, rowTime, publicUser, userFromRow, getRoomById, canManageRoom, roomPower, canModerateRoom, getRoomMembership, logModeration, deleteUploadUrl, getLiveByRoom: () => realtime.liveByRoom }));

app.use('/api', createAuthRouter({ pool, bcrypt, cleanText, makeId, now, signToken, publicUser, userFromRow, auth, requireActiveUser }));

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
    console.log(`\n${APP_NAME} ${VERSION}\nhttp://localhost:${actual}\nفحص: http://localhost:${actual}/api/health\n`);
  };
  server.once('error', onError);
  server.once('listening', onListening);
    server.listen(port, env.HOST);
}

function shutdown(done = () => process.exit(0)) {
  io.close(() => server.close(() => pool.end(done)));
}

module.exports = { app, server, io, pool, initDb, startServer, shutdown, logError };
