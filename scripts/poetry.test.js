'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRoomsService } = require('../src/services/roomsService');
const { createPostsRepository } = require('../src/repositories/postsRepository');
const { createSharedRepository } = require('../src/repositories/sharedRepository');

const ROOT = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

function mockRoomService() {
  const created = [];
  const svc = createRoomsService({
    roomsRepository: {
      listRooms: async () => [],
      createRoom: async room => created.push(room)
    },
    cleanText: (text, max) => String(text || '').trim().slice(0, max),
    makeId: () => 'test-room',
    now: () => '2026-11-12T00:00:00.000Z',
    rowTime: value => value,
    publicUser: user => user,
    userFromRow: row => row,
    getLiveByRoom: () => new Map(),
    livePublic: live => live
  });
  return { svc, created };
}

test('Only the three poetic room kinds may be created', async () => {
  const { svc, created } = mockRoomService();
  for (const poetryKind of ['reply','dialogue','zamil']) {
    const room = await svc.createRoom('poet-1', { id:'poet-1' }, { name:'مجلس الشعر', description:'قصائد', poetryKind });
    assert.equal(room.poetryKind, poetryKind);
  }
  assert.equal(created.length, 3);
  await assert.rejects(svc.createRoom('poet-1', {}, { name:'مجلس الأخبار', poetryKind:'news' }), { status:400 });
  assert.equal(created.length, 3);
});

test('Feed query is limited to poetry rooms and supports category filter', async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows:[] }; } };
  const posts = createPostsRepository({ pool });
  await posts.listFeed({ room:'', q:'بيت', poetryKind:'dialogue' });
  assert.match(queries[0].sql, /join rooms r on r\.id = p\.room_id and r\.poetry_kind in/);
  assert.match(queries[0].sql, /r\.poetry_kind = \$3/);
  assert.deepEqual(queries[0].params, ['', '%بيت%', 'dialogue']);
});

test('Direct room and post lookups exclude legacy content', async () => {
  const queries = [];
  const pool = { query: async sql => { queries.push(sql); return { rows:[], rowCount:0 }; } };
  const shared = createSharedRepository({ pool, userFromRow: x => x });
  assert.equal(await shared.roomExists('local'), false);
  assert.equal(await shared.getRoomById('local'), null);
  await shared.getPostForViewer('old-post');
  for (const sql of queries) assert.match(sql, /poetry_kind in/);
});

test('Political news and news-channel APIs are absent from the running server', () => {
  const source = read('src/app.js');
  const html = read('public/index.html');
  assert.doesNotMatch(source, /political-news|createChannelsRouter|fetchPoliticalNews|youtubeLiveResolver/);
  assert.doesNotMatch(html, /newsStrip|globalChannels|channelTheater/);
});

test('The streaming system and client controls remain available', () => {
  const realtime = read('src/services/realtimeService.js');
  const html = read('public/index.html');
  for (const event of ['live:start','live:watch','live:guest-accept','voice:join']) {
    assert.ok(realtime.includes(event), `Missing ${event}`);
  }
  for (const id of ['startLiveBtn','watchLiveBtn','liveStage','liveGuestSelect','joinVoiceBtn']) {
    assert.ok(html.includes(`id="${id}"`), `Missing ${id}`);
  }
});

test('Schema seeds three poetry categories without erasing legacy rooms', () => {
  const schema = read('schema.sql');
  for (const id of ['poetry-replies','poetry-dialogues','poetry-zawamil']) assert.ok(schema.includes(id));
  assert.doesNotMatch(schema, /delete\s+from\s+rooms|drop\s+table\s+rooms/i);
  assert.doesNotMatch(schema, /insert\s+into\s+news_channels/i);
});
