'use strict';

const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { buildUsers, OUT_FILE } = require('../scripts/seed');
const { createServer, loadUsers, searchUsers } = require('../server/app');

let server;
let base;
const users = loadUsers(OUT_FILE);

before(async () => {
  server = createServer(users);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('database holds 400 users with unique names and SVG pictures', () => {
  assert.equal(users.size, 400);
  const names = new Set([...users.values()].map((u) => u.name));
  assert.equal(names.size, 400);
  for (const user of users.values()) assert.match(user.picture, /^<svg[\s\S]*<\/svg>$/);
});

test('seed is deterministic and matches the committed database', () => {
  assert.deepEqual(buildUsers(), [...users.values()]);
});

test('search ranks prefix matches before word and substring matches', () => {
  const results = searchUsers(users, 'ar');
  const names = results.map((r) => r.name.toLowerCase());
  const firstNonPrefix = names.findIndex((n) => !n.startsWith('ar'));
  if (firstNonPrefix !== -1) assert.ok(names.slice(firstNonPrefix).every((n) => !n.startsWith('ar')));
  assert.ok(results.length <= 10);
});

test('search is case-insensitive and ignores empty queries', () => {
  assert.deepEqual(searchUsers(users, '   '), []);
  assert.deepEqual(searchUsers(users, 'VIVEK'), searchUsers(users, 'vivek'));
});

test('GET /api/users/search returns suggestions', async () => {
  const res = await fetch(`${base}/api/users/search?q=a`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.length, 10);
  assert.deepEqual(Object.keys(body[0]).sort(), ['id', 'name', 'picture']);
});

test('GET /api/users/:id and its picture', async () => {
  const user = await (await fetch(`${base}/api/users/1`)).json();
  assert.equal(user.name, users.get(1).name);

  const pic = await fetch(`${base}${user.picture}`);
  assert.equal(pic.headers.get('content-type'), 'image/svg+xml');
  assert.equal(await pic.text(), users.get(1).picture);

  assert.equal((await fetch(`${base}/api/users/9999`)).status, 404);
});

test('serves the frontend and blocks path traversal', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="search-input"/);
  assert.notEqual((await fetch(`${base}/..%2fpackage.json`)).status, 200);
});
