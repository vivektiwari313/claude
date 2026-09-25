'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildUsers, OUT_FILE: SAMPLE_FILE } = require('../scripts/seed');
const { OUT_FILE: MEMBERS_FILE } = require('../scripts/import-members');
const { createServer, loadUsers } = require('./app');
const { createNotifier } = require('./slack');

// Imported members (scripts/import-members.js) take precedence over the generated sample users.
let dbFile = MEMBERS_FILE;
if (!fs.existsSync(dbFile)) {
  dbFile = SAMPLE_FILE;
  if (!fs.existsSync(dbFile)) fs.writeFileSync(dbFile, JSON.stringify(buildUsers(), null, 1) + '\n');
}

const users = loadUsers(dbFile);
const port = Number(process.env.PORT) || 3000;

// Slack DMs are sent only when a bot token is configured; see README.
const notifier = createNotifier({
  token: process.env.SLACK_BOT_TOKEN,
  appUrl: process.env.APP_URL,
  maxPerColleaguePerDay: Number(process.env.SLACK_MAX_DMS_PER_COLLEAGUE_PER_DAY) || 10,
  stateFile: path.join(__dirname, '..', 'private', 'hit-log.json'),
});
fs.mkdirSync(path.join(__dirname, '..', 'private'), { recursive: true });

createServer(users, { notifier }).listen(port, () => {
  console.log(`Loaded ${users.size} users from ${dbFile}. Open http://localhost:${port}`);
  console.log(notifier.configured ? 'Slack DMs are on.' : 'Slack DMs are off (set SLACK_BOT_TOKEN to turn them on).');
});
