// Bundles the frontend and the whole user database into one self-contained HTML file,
// standalone/user-search.html, that works by double-clicking: no server, npm or network.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { OUT_FILE: DB_FILE } = require('./seed');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT_FILE = path.join(ROOT, 'standalone', 'user-search.html');

const read = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');

// Keeps inline script content from closing its own <script> tag.
const inlineSafe = (code) => code.replace(/<\/(script)/gi, '<\\/$1');

function embeddedApi() {
  const users = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const json = JSON.stringify(users).replace(/</g, '\\u003c');
  return `// Embedded "backend": the full user database, searched in the page.
'use strict';

(function () {
  const USERS = ${json}.map((u) => ({
    id: u.id,
    name: u.name,
    picture: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(u.picture),
  }));

  window.UserApi = {
    async search(query) {
      return rankUsers(USERS, query, 10);
    },
  };
})();
`;
}

function build() {
  const scripts = [read('search.js'), embeddedApi(), read('app.js')]
    .map((code) => `<script>\n${inlineSafe(code)}</script>`)
    .join('\n');

  let html = read('index.html');
  html = html.replace(/<link rel="stylesheet" href="\/styles.css">/, () => `<style>\n${read('styles.css')}</style>`);
  html = html.replace(/(\s*<script src="[^"]+"><\/script>)+/, () => `\n  ${scripts}`);
  if (/src="\/|href="\//.test(html)) throw new Error('Standalone build still references server files');
  return html;
}

if (require.main === module) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, build());
  const kb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`Wrote ${path.relative(process.cwd(), OUT_FILE)} (${kb} KB)`);
}

module.exports = { build, OUT_FILE };
