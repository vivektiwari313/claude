#!/usr/bin/env node
// Card Finder server: serves the app, keeps everyone's cards and requests in one shared
// file, and sends Slack DMs through a Slack app.
//
//   SLACK_BOT_TOKEN=xoxb-... APP_URL=http://localhost:8000 node server.js
//
// Without SLACK_BOT_TOKEN the app still works; Slack messages fall back to previews.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PURPOSES: PURPOSE_LIST, emptyState, applyOp } = require("./ops.js");

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8000;
const TOKEN = process.env.SLACK_BOT_TOKEN || "";
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
// Overridable so tests can point at a fake Slack.
const SLACK_API = (process.env.SLACK_API_BASE || "https://slack.com/api").replace(/\/$/, "");
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, "data", "state.json");

const PURPOSES = new Set(PURPOSE_LIST);

function loadData(file, name) {
  const text = fs.readFileSync(path.join(ROOT, "data", file), "utf8");
  const m = text.match(new RegExp(`window\\.${name} = (\\[[\\s\\S]*\\]);`));
  if (!m) throw new Error(`Couldn't read ${file}`);
  return JSON.parse(m[1]);
}
const employees = new Map(loadData("employees.js", "EMPLOYEES").map((e) => [e.id, e]));
const cards = new Map(loadData("cards.js", "CARD_CATALOGUE").map((c) => [c.id, c]));

// ---------- shared state ----------
function loadState() {
  try {
    return Object.assign(emptyState(), JSON.parse(fs.readFileSync(STATE_FILE, "utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`Couldn't read ${STATE_FILE}: ${err.message}. Starting empty.`);
    return emptyState();
  }
}
let state = loadState();
function saveState() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE); // atomic replace, so a crash never leaves half a file
}
const ctx = {
  employees,
  cards,
  now: () => new Date().toISOString(),
  newId: () => `r${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`,
};

// ---------- Slack ----------
const first = (e) => e.name.split(/\s+/)[0];
const cardName = (c) => `${c.issuer} ${c.name}`;
// Slack mrkdwn: escape &, <, > in anything user-written.
const mrkdwn = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function openButton(label, hash) {
  return {
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text: label }, url: `${APP_URL}/#${hash}`, style: "primary" }],
  };
}

function buildMessages(body) {
  const from = employees.get(body.from);
  const card = cards.get(body.cardId);
  if (!from) throw new Error("Unknown sender.");
  if (!card) throw new Error("Unknown card.");

  if (body.type === "request") {
    const to = [...new Set(body.to || [])];
    if (!to.length || to.length > 50) throw new Error("Pick between 1 and 50 people.");
    if (!PURPOSES.has(body.purpose)) throw new Error("Unknown purpose.");
    const note = String(body.note || "").slice(0, 500).trim();
    return to.map((id) => {
      const rcpt = employees.get(id);
      if (!rcpt || id === from.id) throw new Error("Unknown receiver.");
      const lines = [
        `Hi ${mrkdwn(first(rcpt))}, *${mrkdwn(from.name)}* is looking for someone with the *${mrkdwn(cardName(card))}*.`,
        `*Purpose:* ${mrkdwn(body.purpose)}`,
        note ? `*Details:* ${mrkdwn(note)}` : "",
        `The first person to accept is matched. ${to.length > 1 ? `${to.length} people were asked.` : ""}`.trim(),
      ].filter(Boolean);
      return {
        channel: id,
        text: `${from.name} is asking for your ${cardName(card)} (${body.purpose})`,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }, openButton("Accept or decline", "inbox")],
      };
    });
  }

  const other = employees.get(body.to && body.to[0]);
  if (!other) throw new Error("Unknown receiver.");
  if (body.type === "accepted") {
    // from = helper who accepted, to = the person who asked
    const text = `*${mrkdwn(from.name)}* accepted your request for the *${mrkdwn(cardName(card))}*. Use the card together offline, then mark it done in Card Finder.`;
    return [{ channel: other.id, text: `${from.name} accepted your Card Finder request`, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, openButton("Open Sent requests", "sent")] }];
  }
  if (body.type === "done") {
    // from = the person who asked, to = helper
    const text = `*${mrkdwn(from.name)}* marked the *${mrkdwn(cardName(card))}* request as done. Thanks for helping! Rate ${mrkdwn(first(from))} in Card Finder.`;
    return [{ channel: other.id, text: `${from.name} marked your Card Finder request done`, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, openButton("Rate in Card Finder", "inbox")] }];
  }
  throw new Error("Unknown message type.");
}

async function postToSlack(msg) {
  const res = await fetch(`${SLACK_API}/chat.postMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ ...msg, unfurl_links: false }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
  return { to: msg.channel, ok: !!data.ok, error: data.ok ? undefined : data.error || "unknown_error" };
}

// ---------- HTTP ----------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
// Only the app itself is served, never scripts or source data.
const PUBLIC = [/^\/index\.html$/, /^\/app\.js$/, /^\/ops\.js$/, /^\/styles\.css$/, /^\/data\/(cards|employees)\.js$/, /^\/images\/cards\/[\w.-]+\.(png|jpe?g|webp|svg)$/];

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 16 * 1024) { reject(new Error("Request too large.")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("Invalid JSON.")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/config" && req.method === "GET") {
    return send(res, 200, { shared: true, slack: !!TOKEN });
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    return send(res, 200, state);
  }

  if (url.pathname === "/api/op" && req.method === "POST") {
    // Browsers send Origin on POST; refuse other sites posting here.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}` && origin !== new URL(APP_URL).origin) {
      return send(res, 403, { ok: false, error: "Wrong origin." });
    }
    let out, body;
    try {
      body = await readJson(req);
      // Work on a copy so a rejected action changes nothing.
      const next = JSON.parse(JSON.stringify(state));
      out = applyOp(next, body.op, body.args || {}, ctx);
      state = next;
      saveState();
    } catch (err) {
      return send(res, err.status || 400, { ok: false, error: err.message, state });
    }
    // Slack is best effort: the action is saved even if a DM fails.
    let slack = null;
    if (TOKEN && out.notify.length) {
      try {
        const results = (await Promise.all(out.notify.map((n) => Promise.all(buildMessages(n).map(postToSlack))))).flat();
        slack = { ok: results.every((r) => r.ok), results };
        if (body.op === "createRequest") {
          // Remember who the DM reached, for the sender's Sent list.
          const r = state.requests.find((x) => x.id === out.result.id);
          if (r) { r.slack = { sentTo: results.filter((x) => x.ok).map((x) => x.to), at: ctx.now() }; saveState(); }
        }
      } catch (err) {
        slack = { ok: false, error: err.message, results: [] };
      }
    }
    return send(res, 200, { ok: true, result: out.result, state, slack });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
  const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  if (!PUBLIC.some((re) => re.test(rel))) return send(res, 404, "Not found", "text/plain");
  fs.readFile(path.join(ROOT, rel), (err, buf) => {
    if (err) return send(res, 404, "Not found", "text/plain");
    send(res, 200, buf, TYPES[path.extname(rel)] || "application/octet-stream");
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Card Finder on ${APP_URL}`);
    console.log(`Shared data: ${STATE_FILE}`);
    console.log(TOKEN ? "Slack: connected (messages are sent)" : "Slack: not connected (set SLACK_BOT_TOKEN to send messages)");
  });
}

module.exports = { server, buildMessages };
