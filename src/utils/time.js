'use strict';

function now() { return new Date().toISOString(); }
function rowTime(v) { return v?.toISOString?.() || v || null; }

module.exports = { now, rowTime };
