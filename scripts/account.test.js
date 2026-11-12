'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuthService } = require('../src/services/authService');

function createMock(user = { id:'u_admin', username:'majid', displayName:'ماجد', bio:'', city:'', website:'', avatarUrl:'', passwordHash:'hashed:old-password', role:'admin', status:'active', createdAt:'2026-01-01' }) {
  const users = new Map([[user.id, { ...user }]]);
  const passwordUpdates = [];
  const usersRepository = {
    findById: async id => users.get(id) || null,
    findByUsername: async username => Array.from(users.values()).find(u => u.username.toLowerCase() === username.toLowerCase()) || null,
    usernameExists: async username => Array.from(users.values()).some(u => u.username.toLowerCase() === username.toLowerCase()),
    createUser: async value => { users.set(value.id, { ...value }); return value; },
    updateProfile: async (id, properties) => {
      users.set(id, { ...users.get(id), ...properties });
      return users.get(id);
    },
    updatePassword: async (id, passwordHash) => {
      passwordUpdates.push({ id, passwordHash });
      users.get(id).passwordHash = passwordHash;
    }
  };
  const service = createAuthService({
    usersRepository,
    bcrypt: { hash: async password => `hashed:${password}`, compare: async (password, hash) => `hashed:${password}` === hash },
    cleanText: (value, max) => String(value || '').trim().slice(0, max),
    makeId: () => 'u_new',
    now: () => '2026-11-13',
    signToken: value => `token:${value.id}`,
    publicUser: value => { const { passwordHash, ...safe } = value; return safe; }
  });
  return { service, users, passwordUpdates };
}

test('Existing administrator logs in with the local users table and keeps their role', async () => {
  const { service } = createMock();
  const session = await service.login({ username:'majid', password:'old-password' });
  assert.equal(session.token, 'token:u_admin');
  assert.equal(session.user.role, 'admin');
  assert.equal(session.user.passwordHash, undefined);
  await assert.rejects(service.login({ username:'majid', password:'wrong' }), { status:401 });
});

test('Registration creates a regular user and login works without Supabase Auth', async () => {
  const { service } = createMock();
  const registered = await service.register({ username:'poet_two', displayName:'شاعر جديد', password:'a-safe-password' });
  assert.equal(registered.user.role, 'user');
  assert.equal(registered.user.passwordHash, undefined);
  assert.equal((await service.login({ username:'POET_TWO', password:'a-safe-password' })).token, registered.token);
  await assert.rejects(service.register({ username:'poet_two', password:'other-password' }), { status:409 });
});

test('Profile changes preserve administrator permissions and validate username identity', async () => {
  const { service } = createMock();
  const updated = await service.updateMe('u_admin', { username:'majid_poet', displayName:'ماجد الصيعري', bio:'رديات ومحاورات', city:'نجران', website:'poetry.example', currentPassword:'old-password' });
  assert.equal(updated.username, 'majid_poet');
  assert.equal(updated.displayName, 'ماجد الصيعري');
  assert.equal(updated.website, 'https://poetry.example/');
  assert.equal(updated.city, 'نجران');
  assert.equal(updated.role, 'admin');
  assert.equal(updated.passwordHash, undefined);
  await assert.rejects(service.updateMe('u_admin', { username:'poet', currentPassword:'wrong' }), { status:403 });
  await assert.rejects(service.updateMe('u_admin', { username:'bad username', currentPassword:'old-password' }), { status:400 });
  await assert.rejects(service.updateMe('u_admin', { website:'javascript:alert(1)' }), { status:400 });
});

test('Password changes require the existing password and persist a new hash', async () => {
  const { service, passwordUpdates } = createMock();
  await assert.rejects(service.updateMe('u_admin', { currentPassword:'invalid', newPassword:'new-strong-password' }), { status:403 });
  await assert.rejects(service.updateMe('u_admin', { currentPassword:'old-password', newPassword:'short' }), { status:400 });
  await service.updateMe('u_admin', { currentPassword:'old-password', newPassword:'new-strong-password' });
  assert.deepEqual(passwordUpdates, [{ id:'u_admin', passwordHash:'hashed:new-strong-password' }]);
  await assert.rejects(service.login({ username:'majid', password:'old-password' }), { status:401 });
  assert.equal((await service.login({ username:'majid', password:'new-strong-password' })).user.role, 'admin');
});

test('New account pages and schema migrations are installed without removing legacy accounts', () => {
  const root = path.resolve(__dirname, '..');
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  const app = read('src/app.js');
  const main = read('public/app.js');
  const schema = read('schema.sql');
  const migrations = read('schema-updates.sql');
  for (const name of ['public/login.html','public/profile.html','public/account-auth.js','public/account-profile.js','public/account-pages.css']) {
    assert.ok(fs.existsSync(path.join(root, name)), `${name} is missing`);
  }
  assert.match(app, /app\.get\(\['\/login', '\/register'\]/);
  assert.match(app, /app\.get\('\/profile'/);
  assert.match(app, /app\.get\('\/api\/users\/:id\/stats'/);
  assert.match(main, /window\.location\.href='\/profile'/);
  for (const sql of [schema,migrations]) {
    assert.match(sql, /alter table users add column if not exists city/i);
    assert.match(sql, /alter table users add column if not exists website/i);
    assert.doesNotMatch(sql, /delete\s+from\s+users|drop\s+table\s+users/i);
  }
});
