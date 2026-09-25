// Zero-dependency HTTP backend: serves the user API and the static frontend.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { rankUsers } = require('../public/search');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_SUGGESTIONS = 10;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function loadUsers(file) {
  const users = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(users.map((u) => [u.id, u]));
}

// `picture` is the photo to show (stored copy first, then the avatar link); `fallback` is the
// generated SVG, used when the photo is missing or fails to load.
function publicUser(user) {
  const fallback = `/api/users/${user.id}/picture`;
  const picture = user.photo ? `/api/users/${user.id}/photo` : user.avatarUrl || fallback;
  return { id: user.id, name: user.name, picture, fallback };
}

function searchUsers(users, rawQuery, limit = MAX_SUGGESTIONS) {
  return rankUsers(users.values(), rawQuery, limit).map(publicUser);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, relative));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });

  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// Players are anonymous; a random cookie tells them apart for the daily Slack limit.
function playerId(req, res) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)player=([\w-]{16,64})/);
  if (match) return match[1];
  const id = crypto.randomUUID();
  res.setHeader('Set-Cookie', `player=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`);
  return id;
}

// POST /api/users/:id/hit: the player's first hit on this user; may send them a Slack DM.
async function handleHit(req, res, users, notifier, id) {
  // A custom header can't be sent cross-site without CORS approval, so other sites can't
  // make a visitor's browser trigger DMs.
  if (req.headers['x-whack-hit'] !== '1') return sendJson(res, 403, { error: 'Forbidden' });
  const user = users.get(id);
  if (!user) return sendJson(res, 404, { error: 'User not found' });
  const player = playerId(req, res);
  if (!notifier) return sendJson(res, 200, { sent: false, reason: 'slack_not_configured' });
  return sendJson(res, 200, await notifier.notifyHit(player, user.slackId));
}

function createServer(users, { notifier } = {}) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    const hit = pathname.match(/^\/api\/users\/(\d+)\/hit$/);
    if (hit) {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      req.resume(); // No body is expected; drain whatever was sent.
      return handleHit(req, res, users, notifier, Number(hit[1])).catch((err) => {
        console.error(err);
        sendJson(res, 500, { error: 'Internal error' });
      });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/api/users/search') {
      return sendJson(res, 200, searchUsers(users, url.searchParams.get('q') || ''));
    }

    const match = pathname.match(/^\/api\/users\/(\d+)(\/picture|\/photo)?$/);
    if (match) {
      const user = users.get(Number(match[1]));
      if (!user) return sendJson(res, 404, { error: 'User not found' });
      if (match[2] === '/photo') {
        const photo = user.photo && user.photo.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
        if (!photo) return sendJson(res, 404, { error: 'No stored photo' });
        res.writeHead(200, { 'Content-Type': photo[1], 'Cache-Control': 'public, max-age=86400' });
        return res.end(Buffer.from(photo[2], 'base64'));
      }
      if (match[2]) {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        return res.end(user.picture);
      }
      return sendJson(res, 200, publicUser(user));
    }

    if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });
    return serveStatic(res, pathname);
  });
}

module.exports = { createServer, loadUsers, searchUsers };
