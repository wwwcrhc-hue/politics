'use strict';

const { initDb, startServer, shutdown, logError } = require('./src/app');

initDb()
  .then(() => startServer())
  .catch(error => {
    logError(error, 'initDb');
    console.error(error);
    process.exitCode = 1;
  });

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
