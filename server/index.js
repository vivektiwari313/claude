'use strict';

const fs = require('node:fs');
const { buildUsers, OUT_FILE } = require('../scripts/seed');
const { createServer, loadUsers } = require('./app');

if (!fs.existsSync(OUT_FILE)) {
  fs.writeFileSync(OUT_FILE, JSON.stringify(buildUsers(), null, 1) + '\n');
}

const users = loadUsers(OUT_FILE);
const port = Number(process.env.PORT) || 3000;

createServer(users).listen(port, () => {
  console.log(`Loaded ${users.size} users. Open http://localhost:${port}`);
});
