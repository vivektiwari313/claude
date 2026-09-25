// Bundles the frontend and the whole user database into one self-contained HTML file,
// standalone/user-search.html, that works by double-clicking: no server, npm or network.
//
//   node scripts/build-standalone.js            sample users -> standalone/user-search.html
//   node scripts/build-standalone.js --members  imported members -> private/user-search.html
//
// Member photos stored by scripts/fetch-photos.js are embedded and work offline; any others
// are linked from their avatar URL (needs internet). Anyone whose photo can't load gets their
// generated picture instead.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { OUT_FILE: SAMPLE_FILE } = require('./seed');
const { OUT_FILE: MEMBERS_FILE } = require('./import-members');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_FILE = path.join(ROOT, 'standalone', 'user-search.html');
const MEMBERS_OUT_FILE = path.join(ROOT, 'private', 'user-search.html');

const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

// Keeps inline script content from closing its own <script> tag.
const inlineSafe = (code) => code.replace(/<\/(script)/gi, '<\\/$1');

function embeddedApi(dbFile) {
  // Only what the page shows; Slack IDs and anything else stay server-side.
  const users = JSON.parse(fs.readFileSync(dbFile, 'utf8')).map(({ id, name, picture, photo, avatarUrl }) => ({ id, name, picture, photo, avatarUrl }));
  const json = JSON.stringify(users).replace(/</g, '\\u003c');
  return `// Embedded "backend": the full user database, searched in the page.
'use strict';

(function () {
  const USERS = ${json}.map((u) => {
    const fallback = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(u.picture);
    return { id: u.id, name: u.name, picture: u.photo || u.avatarUrl || fallback, fallback };
  });

  window.UserApi = {
    async search(query) {
      return rankUsers(USERS, query, 10);
    },
    // There is no server to send Slack messages from here.
    async hit() {
      return { sent: false, reason: 'no_server' };
    },
  };
})();
`;
}

function build(dbFile = SAMPLE_FILE) {
  let html = read('index.html');
  const scripts = [...html.matchAll(/<script src="\/([\w.-]+)"><\/script>/g)]
    .map(([, file]) => (file === 'api.js' ? embeddedApi(dbFile) : read(file)))
    .map((code) => `<script>\n${inlineSafe(code)}</script>`)
    .join('\n');

  html = html.replace(/<link rel="stylesheet" href="\/styles.css">/, () => `<style>\n${read('styles.css')}</style>`);
  html = html.replace(/(\s*<script src="[^"]+"><\/script>)+/, () => `\n  ${scripts}`);
  if (/src="\/|href="\//.test(html)) throw new Error('Standalone build still references server files');
  return html;
}

if (require.main === module) {
  const members = process.argv.includes('--members');
  if (members && !fs.existsSync(MEMBERS_FILE)) {
    console.error('No imported members yet. Run: node scripts/import-members.js path/to/members.json');
    process.exit(1);
  }
  const out = members ? MEMBERS_OUT_FILE : OUT_FILE;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, build(members ? MEMBERS_FILE : SAMPLE_FILE));
  const kb = Math.round(fs.statSync(out).size / 1024);
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${kb} KB)`);
}

module.exports = { build, OUT_FILE };
