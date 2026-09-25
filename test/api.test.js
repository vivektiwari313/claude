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
    assert.deepEqual(Object.keys(m).sort(), ['avatarUrl', 'id', 'name', 'picture', 'slackId']);
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

// A fake Slack Web API that records the DMs it was asked to send.
async function fakeSlack() {
  const http = require('node:http');
  const sent = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = JSON.parse(body);
      const auth = req.headers.authorization;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (auth !== 'Bearer xoxb-test') return res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
      if (req.url === '/conversations.open') {
        if (data.users === 'UGONE') return res.end(JSON.stringify({ ok: false, error: 'user_not_found' }));
        return res.end(JSON.stringify({ ok: true, channel: { id: `D-${data.users}` } }));
      }
      sent.push(data);
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  return { sent, server, apiBase: `http://127.0.0.1:${server.address().port}` };
}

test('notifier DMs a colleague once a day per player, anonymously', async () => {
  const { createNotifier, DAY_MS } = require('../server/slack');
  const slack = await fakeSlack();
  let clock = 1_000_000;
  const notifier = createNotifier({ token: 'xoxb-test', apiBase: slack.apiBase, now: () => clock, maxPerColleaguePerDay: 2 });
  try {
    assert.deepEqual(await notifier.notifyHit('player-a', 'U1'), { sent: true });
    assert.deepEqual(slack.sent, [{ channel: 'D-U1', text: 'Someone hit you at *Whack your colleague*' }]);

    assert.equal((await notifier.notifyHit('player-a', 'U1')).reason, 'already_notified_today');
    assert.equal((await notifier.notifyHit('player-b', 'U1')).sent, true); // Different player.
    assert.equal((await notifier.notifyHit('player-c', 'U1')).reason, 'colleague_daily_limit');
    assert.equal((await notifier.notifyHit('player-a', null)).reason, 'no_slack_account');

    clock += DAY_MS;
    assert.equal((await notifier.notifyHit('player-a', 'U1')).sent, true); // A day later.

    // A failed send is not counted, so it can be retried.
    assert.equal((await notifier.notifyHit('player-a', 'UGONE')).reason, 'slack_error');
    assert.equal((await notifier.notifyHit('player-a', 'UGONE')).reason, 'slack_error');
    assert.equal(slack.sent.length, 3);
  } finally {
    slack.server.close();
  }
  assert.equal((await createNotifier({}).notifyHit('p', 'U1')).reason, 'slack_not_configured');
  const linked = createNotifier({ token: 't', appUrl: 'https://whack.example.com' });
  assert.equal(linked.message(), 'Someone hit you at *<https://whack.example.com|Whack your colleague>*');
});

test('POST /api/users/:id/hit uses a player cookie and needs the hit header', async () => {
  const { createNotifier } = require('../server/slack');
  const slack = await fakeSlack();
  const members = new Map([[1, { id: 1, name: 'Ana Bell', slackId: 'U1', picture: '<svg/>' }]]);
  const notifier = createNotifier({ token: 'xoxb-test', apiBase: slack.apiBase });
  const app = createServer(members, { notifier });
  await new Promise((resolve) => app.listen(0, resolve));
  const url = `http://127.0.0.1:${app.address().port}/api/users/1/hit`;
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 403);
    assert.equal((await fetch(url)).status, 405);

    const first = await fetch(url, { method: 'POST', headers: { 'X-Whack-Hit': '1' } });
    assert.deepEqual(await first.json(), { sent: true });
    const cookie = first.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^player=[\w-]+$/);

    const again = await fetch(url, { method: 'POST', headers: { 'X-Whack-Hit': '1', Cookie: cookie } });
    assert.equal((await again.json()).reason, 'already_notified_today');
    assert.equal(slack.sent.length, 1);

    // The Slack ID never leaves the server.
    const user = await (await fetch(url.replace('/hit', ''))).json();
    assert.equal(JSON.stringify(user).includes('U1'), false);
    assert.equal((await fetch(url.replace('/1/', '/99/'), { method: 'POST', headers: { 'X-Whack-Hit': '1' } })).status, 404);
  } finally {
    app.close();
    slack.server.close();
  }
});

test('import-members keeps valid Slack user IDs only', () => {
  const { buildMembers } = require('../scripts/import-members');
  const members = buildMembers([
    { id: 'U0FAKE00001', name: 'A One' },
    { id: 'bogus', name: 'B Two' },
    { name: 'C Three' },
  ]);
  assert.deepEqual(members.map((m) => m.slackId), ['U0FAKE00001', null, null]);
});

test('standalone build leaves out Slack IDs', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { build } = require('../scripts/build-standalone');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'whack-')), 'members.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 1, name: 'Ana Bell', slackId: 'U0SECRET1', avatarUrl: null, picture: '<svg/>' }]));
  const html = build(file);
  assert.match(html, /Ana Bell/);
  assert.doesNotMatch(html, /U0SECRET1/);
});
