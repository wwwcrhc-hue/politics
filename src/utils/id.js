'use strict';

function makeId(prefix = 'id') { return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`; }

module.exports = { makeId };
