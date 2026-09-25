// Sends the anonymous "Someone hit you" Slack DM through a bot, at most once a day for each
// player and colleague. The bot token stays on the server; players are told nothing about it.
'use strict';

const fs = require('node:fs');

const DAY_MS = 24 * 60 * 60 * 1000;
const APP_NAME = 'Whack your colleague';

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { pairs: state.pairs || {}, targets: state.targets || {} };
  } catch {
    return { pairs: {}, targets: {} };
  }
}

// `pairs` maps "player|slackId" to when that player last notified that colleague; `targets`
// lists when each colleague was notified by anyone, for the per-colleague daily cap.
function createNotifier({
  token,
  appUrl,
  stateFile,
  maxPerColleaguePerDay = 10,
  apiBase = 'https://slack.com/api',
  fetchImpl = fetch,
  now = Date.now,
}) {
  const state = stateFile ? loadState(stateFile) : { pairs: {}, targets: {} };

  function save() {
    const cutoff = now() - DAY_MS;
    for (const [key, at] of Object.entries(state.pairs)) if (at <= cutoff) delete state.pairs[key];
    for (const [id, times] of Object.entries(state.targets)) {
      state.targets[id] = times.filter((at) => at > cutoff);
      if (!state.targets[id].length) delete state.targets[id];
    }
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state));
  }

  async function slack(method, body) {
    const res = await fetchImpl(`${apiBase}/${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Slack ${method} failed: ${data.error || res.status}`);
    return data;
  }

  function message() {
    const name = appUrl ? `<${appUrl}|${APP_NAME}>` : APP_NAME;
    return `Someone hit you at *${name}*`;
  }

  async function notifyHit(playerId, slackId) {
    if (!token) return { sent: false, reason: 'slack_not_configured' };
    if (!slackId) return { sent: false, reason: 'no_slack_account' };

    const at = now();
    const pair = `${playerId}|${slackId}`;
    if (state.pairs[pair] && at - state.pairs[pair] < DAY_MS) return { sent: false, reason: 'already_notified_today' };
    const recent = (state.targets[slackId] || []).filter((t) => at - t < DAY_MS);
    if (recent.length >= maxPerColleaguePerDay) return { sent: false, reason: 'colleague_daily_limit' };

    // Recorded before sending, so two quick requests can't both send.
    state.pairs[pair] = at;
    state.targets[slackId] = [...recent, at];
    save();

    try {
      const { channel } = await slack('conversations.open', { users: slackId });
      await slack('chat.postMessage', { channel: channel.id, text: message() });
      return { sent: true };
    } catch (err) {
      // Nothing was delivered, so let a later hit try again.
      delete state.pairs[pair];
      state.targets[slackId] = state.targets[slackId].filter((t) => t !== at);
      save();
      console.error(err.message);
      return { sent: false, reason: 'slack_error' };
    }
  }

  return { notifyHit, message, configured: Boolean(token) };
}

module.exports = { createNotifier, DAY_MS };
