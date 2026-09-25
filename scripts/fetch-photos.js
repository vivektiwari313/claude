// Downloads every imported member's photo from their avatar URL and stores it inside
// private/members.json, so builds show the real photos without any network access.
//
//   node scripts/fetch-photos.js            fetch photos that aren't stored yet
//   node scripts/fetch-photos.js --refresh  re-download all of them
//
// Photos that can't be downloaded are reported and left as links, so a later run can retry them.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { OUT_FILE: MEMBERS_FILE } = require('./import-members');

const PHOTO_SIZE = 512;
const MAX_BYTES = 3 * 1024 * 1024;
const CONCURRENCY = 8;
const TIMEOUT_MS = 20000;

// Slack and Gravatar serve smaller renditions of the same photo; the originals can be
// several megabytes, which would make the standalone file huge.
function sizedUrl(url) {
  const u = new URL(url);
  if (u.hostname === 'avatars.slack-edge.com') {
    return url.replace(/_original(\.\w+)$/, `_${PHOTO_SIZE}$1`);
  }
  if (u.hostname.endsWith('gravatar.com')) {
    u.searchParams.set('s', String(PHOTO_SIZE));
    return u.toString();
  }
  return url;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'no content type'})`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`too large (${body.length} bytes)`);
  return `data:${type};base64,${body.toString('base64')}`;
}

async function fetchPhoto(avatarUrl) {
  const sized = sizedUrl(avatarUrl);
  try {
    return await download(sized);
  } catch (err) {
    if (sized === avatarUrl) throw err;
    return download(avatarUrl); // The smaller rendition may not exist; use the original.
  }
}

async function fetchPhotos(members, { refresh = false, log = console.log } = {}) {
  const todo = members.filter((m) => m.avatarUrl && (refresh || !m.photo));
  const failures = [];
  let next = 0;
  let done = 0;

  async function worker() {
    while (next < todo.length) {
      const member = todo[next++];
      try {
        member.photo = await fetchPhoto(member.avatarUrl);
      } catch (err) {
        failures.push({ name: member.name, url: member.avatarUrl, error: err.cause?.message || err.message });
      }
      done++;
      if (done % 50 === 0 || done === todo.length) log(`  ${done}/${todo.length}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return { attempted: todo.length, failures };
}

if (require.main === module) {
  (async () => {
    if (!fs.existsSync(MEMBERS_FILE)) {
      console.error('No imported members yet. Run: node scripts/import-members.js path/to/members.json');
      process.exit(1);
    }
    const members = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
    console.log('Downloading photos…');
    const { attempted, failures } = await fetchPhotos(members, { refresh: process.argv.includes('--refresh') });
    fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 1) + '\n');

    const stored = members.filter((m) => m.photo).length;
    const noUrl = members.filter((m) => !m.avatarUrl).length;
    console.log(`Downloaded ${attempted - failures.length}/${attempted}. ${stored} of ${members.length} members now have a stored photo; ${noUrl} have no avatar URL.`);
    for (const f of failures) console.log(`  failed: ${f.name}: ${f.error} (${f.url})`);
    if (failures.length) {
      console.log('Run this script again to retry the failed ones.');
      process.exitCode = 2;
    }
  })();
}

module.exports = { fetchPhotos, sizedUrl };
