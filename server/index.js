'use strict';

const fs = require('node:fs');
const { buildUsers, OUT_FILE: SAMPLE_FILE } = require('../scripts/seed');
const { OUT_FILE: MEMBERS_FILE } = require('../scripts/import-members');
const { createServer, loadUsers } = require('./app');

// Imported members (scripts/import-members.js) take precedence over the generated sample users.
let dbFile = MEMBERS_FILE;
if (!fs.existsSync(dbFile)) {
  dbFile = SAMPLE_FILE;
  if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify(buildUsers(), null, 1) + '\n');
}

const users = loadUsers(dbFile);
const port = Number(process.env.PORT) || 3000;

createServer(users).listen(port, () => {
  console.log(`Loaded ${users.size} users from ${dbFile}. Open http://localhost:${port}`);
});
