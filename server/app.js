// Zero-dependency HTTP backend: serves the user API and the static frontend.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

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

function publicUser(user) {
  return { id: user.id, name: user.name, picture: `/api/users/${user.id}/picture` };
}

// Ranks names that start with the query first, then names where any word starts with it,
// then any substring match. Ties are broken alphabetically.
function searchUsers(users, rawQuery, limit = MAX_SUGGESTIONS) {
  const query = rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!query) return [];

  const scored = [];
  for (const user of users.values()) {
    const name = user.name.toLowerCase();
    let rank;
    if (name.startsWith(query)) rank = 0;
    else if (name.split(' ').some((word) => word.startsWith(query))) rank = 1;
    else if (name.includes(query)) rank = 2;
    else continue;
    scored.push({ rank, user });
  }

  scored.sort((a, b) => a.rank - b.rank || a.user.name.localeCompare(b.user.name));
  return scored.slice(0, limit).map(({ user }) => publicUser(user));
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

function createServer(users) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (pathname === '/api/users/search') {
      return sendJson(res, 200, searchUsers(users, url.searchParams.get('q') || ''));
    }

    const match = pathname.match(/^\/api\/users\/(\d+)(\/picture)?$/);
    if (match) {
      const user = users.get(Number(match[1]));
      if (!user) return sendJson(res, 404, { error: 'User not found' });
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
