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
  assert.deepEqual(Object.keys(body[0]).sort(), ['fallback', 'id', 'name', 'picture']);
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

test('standalone build is up to date with the sources', () => {
  const fs = require('node:fs');
  const { build, OUT_FILE: STANDALONE } = require('../scripts/build-standalone');
  assert.equal(fs.readFileSync(STANDALONE, 'utf8'), build(), 'run: node scripts/build-standalone.js');
});

test('import-members keeps only name and https photo, with a fallback picture', () => {
  const { buildMembers } = require('../scripts/import-members');
  const members = buildMembers({
    members: [
      { id: 'U2', name: 'Zed  Quinn', title: 'Secret', avatar_url: 'https://example.com/z.jpg' },
      { id: 'U1', name: 'Ana Bell', avatar_url: null },
      { id: 'U3', name: 'Bad Link', avatar_url: 'javascript:alert(1)' },
      { name: '   ' },
    ],
  });
  assert.deepEqual(members.map((m) => [m.name, m.avatarUrl]), [
    ['Ana Bell', null], ['Bad Link', null], ['Zed Quinn', 'https://example.com/z.jpg'],
  ]);
  for (const m of members) {
    assert.deepEqual(Object.keys(m).sort(), ['avatarUrl', 'id', 'name', 'picture']);
    assert.match(m.picture, /^<svg[\s\S]*<\/svg>$/);
  }

  const { searchUsers } = require('../server/app');
  const [zed] = searchUsers(new Map(members.map((m) => [m.id, m])), 'zed');
  assert.equal(zed.picture, 'https://example.com/z.jpg');
  assert.equal(zed.fallback, `/api/users/${zed.id}/picture`);
});

test('sizedUrl asks Slack and Gravatar for 512px renditions', () => {
  const { sizedUrl } = require('../scripts/fetch-photos');
  assert.equal(sizedUrl('https://avatars.slack-edge.com/2025-01-01/1_ab_original.jpg'), 'https://avatars.slack-edge.com/2025-01-01/1_ab_512.jpg');
  assert.equal(sizedUrl('https://secure.gravatar.com/avatar/x.jpg?d=a'), 'https://secure.gravatar.com/avatar/x.jpg?d=a&s=512');
  assert.equal(sizedUrl('https://example.com/p.png'), 'https://example.com/p.png');
});

test('fetchPhotos stores images as data URIs and reports failures', async () => {
  const http = require('node:http');
  const { fetchPhotos } = require('../scripts/fetch-photos');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const photoServer = http.createServer((req, res) => {
    if (req.url === '/ok.png') return res.writeHead(200, { 'Content-Type': 'image/png' }), res.end(png);
    if (req.url === '/page.html') return res.writeHead(200, { 'Content-Type': 'text/html' }), res.end('<p>login</p>');
    res.writeHead(404).end();
  });
  await new Promise((resolve) => photoServer.listen(0, resolve));
  const host = `http://127.0.0.1:${photoServer.address().port}`;
  const members = [
    { name: 'Has Photo', avatarUrl: `${host}/ok.png` },
    { name: 'Missing', avatarUrl: `${host}/gone.png` },
    { name: 'Not Image', avatarUrl: `${host}/page.html` },
    { name: 'No Url', avatarUrl: null },
  ];
  try {
    const { attempted, failures } = await fetchPhotos(members, { log: () => {} });
    assert.equal(attempted, 3);
    assert.equal(members[0].photo, `data:image/png;base64,${png.toString('base64')}`);
    assert.deepEqual(failures.map((f) => [f.name, f.error]).sort(), [['Missing', 'HTTP 404'], ['Not Image', 'not an image (text/html)']]);
    assert.equal(members[1].photo, undefined);

    // Stored photos win over links in both the API and the standalone build.
    const { searchUsers } = require('../server/app');
    const users = new Map(members.map((m, i) => [i + 1, { ...m, id: i + 1, picture: '<svg/>' }]));
    assert.equal(searchUsers(users, 'has photo')[0].picture, '/api/users/1/photo');
    assert.equal(searchUsers(users, 'missing')[0].picture, `${host}/gone.png`);
  } finally {
    photoServer.close();
  }
});
