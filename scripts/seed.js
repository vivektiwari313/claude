// Generates data/users.json: 400 users, each with a unique name and an SVG display picture.
// Output is deterministic (seeded PRNG), so re-running produces the same database.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const USER_COUNT = 400;
const OUT_FILE = path.join(__dirname, '..', 'data', 'users.json');

const FIRST_NAMES = [
  'Aarav', 'Aditi', 'Akira', 'Alex', 'Amara', 'Ananya', 'Arjun', 'Ava', 'Bella', 'Carlos',
  'Chen', 'Chloe', 'Daniel', 'Diya', 'Elena', 'Ethan', 'Farah', 'Felix', 'Grace', 'Hana',
  'Hugo', 'Ishaan', 'Isla', 'Jin', 'Kabir', 'Kai', 'Kavya', 'Leo', 'Lina', 'Luca',
  'Maya', 'Mei', 'Mira', 'Nadia', 'Neha', 'Noah', 'Omar', 'Priya', 'Rahul', 'Riya',
  'Rohan', 'Sara', 'Sofia', 'Tara', 'Theo', 'Vivek', 'Yara', 'Yuki', 'Zara', 'Zoe',
];

const LAST_NAMES = [
  'Agarwal', 'Bose', 'Brown', 'Chopra', 'Costa', 'Das', 'Diaz', 'Evans', 'Fischer', 'Garcia',
  'Gupta', 'Haddad', 'Ito', 'Iyer', 'Joshi', 'Kapoor', 'Kim', 'Kumar', 'Lee', 'Lopez',
  'Mehta', 'Menon', 'Moreau', 'Nair', 'Novak', 'Okafor', 'Patel', 'Reddy', 'Rossi', 'Sato',
  'Shah', 'Silva', 'Singh', 'Smith', 'Tanaka', 'Tiwari', 'Verma', 'Wang', 'Weber', 'Yadav',
];

const BACKGROUNDS = [
  ['#6366f1', '#a855f7'], ['#0ea5e9', '#22d3ee'], ['#f97316', '#facc15'], ['#10b981', '#84cc16'],
  ['#ef4444', '#f472b6'], ['#14b8a6', '#3b82f6'], ['#8b5cf6', '#ec4899'], ['#f59e0b', '#ef4444'],
];
const SKIN_TONES = ['#f9d7c0', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a21'];
const HAIR_COLORS = ['#1f1300', '#3b2314', '#6b4423', '#a0522d', '#d4a017', '#2f2f2f', '#b33a3a'];
const SHIRT_COLORS = ['#1e293b', '#0f766e', '#7c2d12', '#312e81', '#831843', '#14532d', '#e2e8f0'];

// Mulberry32: tiny deterministic PRNG.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function shuffle(rand, list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function hairPath(style) {
  switch (style) {
    case 0: // short crop
      return 'M62 96c0-40 26-60 58-60s58 20 58 60c-8-18-30-28-58-28s-50 10-58 28z';
    case 1: // side part
      return 'M60 104c-4-46 22-70 60-70 34 0 62 20 60 62-18-20-48-30-86-22-14 4-24 14-34 30z';
    case 2: // long
      return 'M58 100c0-42 28-64 62-64s62 22 62 64v70c-8 0-14-6-16-14V104c-14-16-30-24-46-24s-32 8-46 24v52c-2 8-8 14-16 14z';
    default: // spiky
      return 'M60 100l6-38 16 14 10-30 14 24 14-30 12 30 14-24 10 30 16-14 6 38c-18-14-38-20-60-20s-42 6-58 20z';
  }
}

function avatarSvg(rand, initials) {
  const [bg1, bg2] = pick(rand, BACKGROUNDS);
  const skin = pick(rand, SKIN_TONES);
  const hair = pick(rand, HAIR_COLORS);
  const shirt = pick(rand, SHIRT_COLORS);
  const style = Math.floor(rand() * 4);
  const smile = rand() > 0.3;
  const glasses = rand() > 0.75;
  const id = `g${Math.floor(rand() * 1e9).toString(36)}`;

  const mouth = smile
    ? '<path d="M104 136q16 14 32 0" fill="none" stroke="#5b2a1a" stroke-width="4" stroke-linecap="round"/>'
    : '<path d="M106 138h28" stroke="#5b2a1a" stroke-width="4" stroke-linecap="round"/>';
  const eyewear = glasses
    ? '<g fill="none" stroke="#111827" stroke-width="3.5"><circle cx="100" cy="112" r="12"/><circle cx="140" cy="112" r="12"/><path d="M112 112h16"/></g>'
    : '';

  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">',
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs>`,
    `<rect width="240" height="240" fill="url(#${id})"/>`,
    `<path d="M40 240c0-46 36-74 80-74s80 28 80 74z" fill="${shirt}"/>`,
    `<rect x="106" y="146" width="28" height="28" rx="8" fill="${skin}"/>`,
    `<ellipse cx="120" cy="112" rx="50" ry="56" fill="${skin}"/>`,
    `<path d="${hairPath(style)}" fill="${hair}"/>`,
    '<circle cx="100" cy="112" r="5" fill="#1f2937"/><circle cx="140" cy="112" r="5" fill="#1f2937"/>',
    eyewear,
    mouth,
    `<text x="226" y="228" text-anchor="end" font-family="Arial,sans-serif" font-size="22" font-weight="700" fill="#ffffff" fill-opacity="0.85">${initials}</text>`,
    '</svg>',
  ].join('');
}

function buildUsers(count = USER_COUNT, seed = 313) {
  const rand = prng(seed);
  const combos = [];
  for (const first of FIRST_NAMES) {
    for (const last of LAST_NAMES) combos.push([first, last]);
  }
  if (count > combos.length) throw new Error(`Only ${combos.length} unique names available`);

  return shuffle(rand, combos)
    .slice(0, count)
    .map(([first, last], i) => ({
      id: i + 1,
      name: `${first} ${last}`,
      picture: avatarSvg(rand, first[0] + last[0]),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((user, i) => ({ ...user, id: i + 1 }));
}

if (require.main === module) {
  const users = buildUsers();
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(users, null, 1) + '\n');
  console.log(`Wrote ${users.length} users to ${path.relative(process.cwd(), OUT_FILE)}`);
}

module.exports = { buildUsers, avatarSvg, prng, OUT_FILE };
