'use strict';

function createHealthController({ pool, appName, version, now, getPort }) {
  async function getHealth(_req, res, next) {
    try {
      await pool.query('select 1');
      res.json({ ok: true, app: appName, version, storage: 'postgres', time: now(), port: getPort() });
    } catch (e) { next(e); }
  }

  return { getHealth };
}

module.exports = { createHealthController };
