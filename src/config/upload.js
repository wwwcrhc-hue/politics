'use strict';

const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

function createUpload({ uploadDir }) {
  const allowedMime = new Map([
    ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/gif', '.gif'],
    ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov']
  ]);
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(10).toString('hex')}${allowedMime.get(file.mimetype) || ''}`)
  });
  return multer({
    storage,
    limits: { files: 4, fileSize: 200 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => allowedMime.has(file.mimetype) ? cb(null, true) : cb(new Error('نوع الملف غير مسموح. استخدم صور JPG/PNG/WEBP/GIF أو فيديو MP4/WEBM/MOV.'))
  });
}

function createDeleteUploadUrl({ uploadDir }) {
  const fs = require('fs');
  return function deleteUploadUrl(url, baseDir = uploadDir) {
    if (!url?.startsWith('/uploads/')) return;
    try { fs.unlinkSync(path.join(baseDir, path.basename(url))); } catch {}
  };
}

module.exports = { createUpload, createDeleteUploadUrl };
