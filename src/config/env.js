'use strict';

require('dotenv').config();

const path = require('path');

function normalizePort(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const env = {
  APP_NAME: 'ساحات سياسية',
  VERSION: '7.0.0',
  HOST: process.env.HOST || '0.0.0.0',
  START_PORT: normalizePort(process.env.PORT, 3000),
  JWT_SECRET: process.env.JWT_SECRET || 'dev-only-change-this-secret-before-public-deployment',
  ROOT_DIR,
  PUBLIC_DIR: path.join(ROOT_DIR, 'public'),
  UPLOAD_DIR: path.join(ROOT_DIR, 'uploads'),
  LOG_DIR: path.join(ROOT_DIR, 'logs'),
  ERROR_LOG: path.join(ROOT_DIR, 'logs', 'error.log'),
  SCHEMA_FILE: path.join(ROOT_DIR, 'schema.sql'),
  DATABASE_URL: process.env.DATABASE_URL || ''
};

module.exports = { env, normalizePort };
