// Imports a member list (e.g. a Slack channel export) into private/members.json, which the
// server and the standalone build use instead of the generated sample users.
//
//   node scripts/import-members.js path/to/members.json
//
// Accepts either { "members": [...] } or a bare array; each member needs a "name" and may have
// an "avatar_url". Only the name and picture link are kept. private/ is git-ignored so real
// people's data never ends up in the repository.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { avatarSvg, prng } = require('./seed');

const OUT_FILE = path.join(__dirname, '..', 'private', 'members.json');

function initials(name) {
  const words = name.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2);
  return letters.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function safeAvatarUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function buildMembers(input) {
  const list = Array.isArray(input) ? input : input && input.members;
  if (!Array.isArray(list)) throw new Error('Expected an array of members or { "members": [...] }');

  return list
    .map((m) => ({ name: typeof m.name === 'string' ? m.name.trim().replace(/\s+/g, ' ') : '', avatarUrl: safeAvatarUrl(m.avatar_url) }))
    .filter((m) => m.name)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((m, i) => ({
      id: i + 1,
      name: m.name,
      avatarUrl: m.avatarUrl,
      // Shown when there is no avatar URL or the image fails to load (e.g. offline).
      picture: avatarSvg(prng(i + 1), initials(m.name)),
    }));
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) {
    console.error('Usage: node scripts/import-members.js path/to/members.json');
    process.exit(1);
  }
  const members = buildMembers(JSON.parse(fs.readFileSync(source, 'utf8')));
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(members, null, 1) + '\n');
  const withPhoto = members.filter((m) => m.avatarUrl).length;
  console.log(`Imported ${members.length} members (${withPhoto} with photos) into ${path.relative(process.cwd(), OUT_FILE)}`);
}

module.exports = { buildMembers, OUT_FILE };
