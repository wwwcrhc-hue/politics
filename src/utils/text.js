'use strict';

function cleanText(v, max) { return String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max); }

module.exports = { cleanText };
