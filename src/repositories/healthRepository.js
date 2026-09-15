'use strict';

function createHealthRepository({ pool }) {
  async function checkDatabase() {
    await pool.query('select 1');
  }

  return { checkDatabase };
}

module.exports = { createHealthRepository };
