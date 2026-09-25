(() => {
  "use strict";

  // Employees whose card count ranks in the top N (ties included) get the Power user badge,
  // as long as they hold at least POWER_USER_MIN_CARDS cards.
  const POWER_USER_TOP_N = 3;
  const POWER_USER_MIN_CARDS = 3;
  const STORAGE_KEY = "cardfinder.v2"; // cards, requests and ratings when there's no server
  const SESSION_KEY = "cardfinder.me";
  // Prototype login: everyone shares one password.
  const PASSWORD = "12345";
  const { PURPOSES, applyOp } = window.CardOps;

  const cards = window.CARD_CATALOGUE || [];
  const employees = (window.EMPLOYEES || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const empById = new Map(employees.map((e) => [e.id, e]));

  // ---------- persisted state ----------
  // Shared mode: server.js holds everyone's data and this page mirrors it.
  // Local mode (opened as a file, no server): data lives in this browser's localStorage.
  const mode = { shared: false, slack: false };
  const read = (key) => {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  };
  const saved = read(STORAGE_KEY) || {};
  const db = { me: read(SESSION_KEY) ?? saved.me ?? "", holdings: saved.holdings || {}, requests: saved.requests || [] };
  function save() {
    write(SESSION_KEY, db.me);
    if (!mode.shared) write(STORAGE_KEY, { holdings: db.holdings, requests: db.requests });
  }
  function cleanUp() {
    // Drop anything saved for people who are no longer in the employee list (e.g. the old sample names).
    if (db.me && !empById.has(db.me)) db.me = "";
    for (const id of Object.keys(db.holdings)) if (!empById.has(id)) delete db.holdings[id];
    db.requests = db.requests.filter((r) => empById.has(r.from) && r.to.some((id) => empById.has(id)));
  }
  cleanUp();

  const localCtx = {
    employees: empById,
    cards: cardById,
    now: () => new Date().toISOString(),
    newId: () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  };

  let lastShared = "";
  function applyShared(state) {
    const json = JSON.stringify(state);
    if (json === lastShared) return false;
    lastShared = json;
    db.holdings = state.holdings || {};
    db.requests = state.requests || [];
    cleanUp();
    return true;
  }

  // Every change goes through here, to the server in shared mode or applied locally otherwise.
  async function run(op, args = {}) {
    const payload = { op, args: { ...args, by: db.me } };
    if (!mode.shared) {
      try {
        const out = applyOp(db, op, payload.args, localCtx);
        save();
        renderAll();
        return { ok: true, result: out.result, slack: null };
      } catch (err) {
        toast(err.message);
        renderAll();
        return null;
      }
    }
    let res, data;
    try {
      res = await fetch("api/op", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      data = await res.json();
    } catch {
      toast("Couldn't reach the Card Finder server. Check your connection and try again.");
      return null;
    }
    if (data.state) applyShared(data.state);
    renderAll();
    if (!res.ok || !data.ok) {
      toast(data.error || `Something went wrong (error ${res.status}).`);
      return null;
    }
    return data;
  }

  // ---------- derived data ----------
  const cardsOf = (empId) => (db.holdings[empId] ?? empById.get(empId)?.cards ?? []).filter((id) => cardById.has(id));
  let holdersByCard = new Map();
  let powerCutoff = Infinity;
  function recompute() {
    holdersByCard = new Map();
    for (const e of employees) {
      for (const id of cardsOf(e.id)) {
        if (!holdersByCard.has(id)) holdersByCard.set(id, []);
        holdersByCard.get(id).push(e);
      }
    }
    const counts = employees.map((e) => cardsOf(e.id).length).filter((n) => n > 0).sort((a, b) => b - a);
    powerCutoff = counts.length ? Math.max(POWER_USER_MIN_CARDS, counts[Math.min(POWER_USER_TOP_N, counts.length) - 1]) : Infinity;
  }
  const holdersOf = (id) => holdersByCard.get(id) || [];
  const isPower = (e) => cardsOf(e.id).length >= powerCutoff;

  // Ratings a person has received, from both sides of finished requests.
  function ratingOf(empId) {
    const stars = [];
    for (const r of db.requests) {
      if (r.status !== "done") continue;
      if (r.matchedWith === empId && r.ratings?.bySender) stars.push(r.ratings.bySender.stars);
      if (r.from === empId && r.ratings?.byReceiver) stars.push(r.ratings.byReceiver.stars);
    }
    return stars.length ? { avg: stars.reduce((a, b) => a + b, 0) / stars.length, n: stars.length } : null;
  }

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9+ ]/g, " ").replace(/\s+/g, " ").trim();
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
  const firstName = (e) => (e ? e.name.split(/\s+/)[0] : "Someone");
  const nameOf = (id) => empById.get(id)?.name || "Someone";
  const when = (iso) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const subtitle = (e) => [e.title || e.team, e.slack].filter(Boolean).join(" · ");
  const slackLink = (e) => (e?.profileUrl ? `<a class="slack-link" href="${esc(e.profileUrl)}" target="_blank" rel="noopener">Slack profile ↗</a>` : "");
  // Two people can share a name; add their title to tell them apart.
  const nameCounts = employees.reduce((m, e) => m.set(e.name, (m.get(e.name) || 0) + 1), new Map());
  const pickerLabel = (e) => (nameCounts.get(e.name) > 1 && e.title ? `${e.name} (${e.title})` : e.name);

  function hashHue(str) {
    let h = 0;
    for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 360;
  }
  const ISSUER_COLORS = {
    "HDFC Bank": ["#0b3a8c", "#0a1f4d"],
    "ICICI Bank": ["#b3471b", "#5a1e0c"],
    "SBI Card": ["#1a6fb8", "#0b2f57"],
    "Axis Bank": ["#8c1c46", "#3f0a1f"],
    "American Express": ["#2b7a9e", "#123b4d"],
    "Kotak Mahindra Bank": ["#c2262e", "#5b0f14"],
    "IDFC FIRST Bank": ["#8a1f2c", "#2e0a10"],
    "IndusInd Bank": ["#7a3b1d", "#2f160a"],
    "YES Bank": ["#1c4f9c", "#0c2146"],
    "AU Small Finance Bank": ["#5b2b82", "#26113a"],
    "RBL Bank": ["#1d3f73", "#0a1a33"],
    "Standard Chartered Bank": ["#0f7a55", "#073826"],
    "HSBC India": ["#a3161c", "#3f0709"],
  };
  function cardBg(card) {
    const pair = ISSUER_COLORS[card.issuer];
    if (pair) return `linear-gradient(135deg, ${pair[0]}, ${pair[1]})`;
    const h = hashHue(card.issuer);
    return `linear-gradient(135deg, hsl(${h} 45% 38%), hsl(${(h + 30) % 360} 50% 16%))`;
  }
  const SHORT_ISSUER = {
    "HDFC Bank": "HDFC", "ICICI Bank": "ICICI", "SBI Card": "SBI", "Axis Bank": "Axis", "American Express": "Amex",
    "Kotak Mahindra Bank": "Kotak", "IDFC FIRST Bank": "IDFC FIRST", "IndusInd Bank": "IndusInd", "YES Bank": "YES",
    "AU Small Finance Bank": "AU", "RBL Bank": "RBL", "Standard Chartered Bank": "SC", "HSBC India": "HSBC",
    "Bank of Baroda / BOBCARD": "BOB", "Federal Bank": "Federal", "Punjab National Bank": "PNB",
    "Equitas Small Finance Bank": "Equitas",
  };
  const shortIssuer = (c) => SHORT_ISSUER[c.issuer] || c.issuer;
  // "SBI SimplyCLICK", but not "SBI Air India SBI Signature Card"
  const shortLabel = (c) => {
    const s = shortIssuer(c);
    return c.name.toLowerCase().includes(s.toLowerCase()) ? c.name : `${s} ${c.name}`;
  };
  // Real card photo when the catalogue has one; the drawn card stays underneath as the fallback.
  const cardImg = (c) => (c.image ? `<img class="card-photo" src="${esc(c.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : "");
  const mini = (c, cls = "mini") => `<span class="${cls}${c.image ? " has-photo" : ""}" style="--card-bg:${cardBg(c)}">${cardImg(c)}</span>`;
  const avatarBg = (e) => `hsl(${hashHue(e.name)} 42% 42%)`;
  const initials = (name) => name.split(/\s+/).filter(Boolean).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  // Initials sit underneath; the Slack photo covers them when it loads and is removed if it fails.
  const avatar = (e) => `<span class="avatar" style="--avatar-bg:${avatarBg(e)}">${esc(initials(e.name))}${e.avatar ? `<img src="${esc(e.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;

  function highlight(text, terms) {
    if (!terms.length) return esc(text);
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    return esc(text).replace(re, "<mark>$1</mark>");
  }

  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>';
  const powerBadge = (e) => (isPower(e) ? `<span class="power" title="Among the top ${POWER_USER_TOP_N} cardholders at GBL (${POWER_USER_MIN_CARDS}+ cards)">${STAR}Power user</span>` : "");
  function ratingBadge(empId) {
    const r = ratingOf(empId);
    return r ? `<span class="rating" title="Average of ${plural(r.n, "rating")}">${STAR}${r.avg.toFixed(1)} <small>(${r.n})</small></span>` : "";
  }
  const starsText = (n) => "★".repeat(n) + "☆".repeat(5 - n);

  // Search index: name, issuer, short issuer ("amex"), aliases
  const index = cards.map((c) => ({
    card: c,
    hay: norm([c.name, c.issuer, shortIssuer(c), ...(c.aliases || []), c.category, c.network].join(" ")),
    name: norm(c.name),
  }));

  // ---------- UI state ----------
  const ui = { query: "", issuer: "", category: "", heldOnly: false, selected: null, purpose: "", receivers: new Set(), note: "", view: "request" };

  // ---------- login ----------
  const login = { pick: null, matches: [], active: -1 };

  function loginMatches(q) {
    const terms = norm(q).split(" ").filter(Boolean);
    if (!terms.length) return [];
    const scored = [];
    for (const e of employees) {
      const n = norm(e.name);
      const words = n.split(" ");
      if (!terms.every((t) => words.some((w) => w.startsWith(t)) || n.includes(t))) continue;
      const score = (n.startsWith(terms[0]) ? 2 : 0) + (words.some((w) => w.startsWith(terms[0])) ? 1 : 0);
      scored.push({ e, score });
    }
    return scored.sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name)).slice(0, 8).map((x) => x.e);
  }

  function renderLoginOptions() {
    const list = $("#login-options");
    const input = $("#login-name");
    const open = login.matches.length > 0 || (input.value.trim() && !login.pick);
    list.hidden = !open;
    input.setAttribute("aria-expanded", String(open));
    if (!open) { input.removeAttribute("aria-activedescendant"); return; }
    if (!login.matches.length) {
      list.innerHTML = `<li class="combo-empty">No one called “${esc(input.value.trim())}”. Check the spelling.</li>`;
      return;
    }
    const terms = norm(input.value).split(" ").filter(Boolean);
    list.innerHTML = login.matches.map((e, i) => `
      <li class="combo-opt" role="option" id="opt-${esc(e.id)}" data-login="${esc(e.id)}" aria-selected="${i === login.active}">
        ${avatar(e)}
        <span class="who"><span class="who-name">${highlight(e.name, terms)}</span><span class="who-meta">${esc(e.title || "GBL")}</span></span>
      </li>`).join("");
    const act = login.matches[login.active];
    if (act) input.setAttribute("aria-activedescendant", `opt-${act.id}`); else input.removeAttribute("aria-activedescendant");
  }

  function pickLogin(id) {
    const e = empById.get(id);
    if (!e) return;
    login.pick = id;
    login.matches = [];
    login.active = -1;
    $("#login-name").value = pickerLabel(e);
    $("#login-error").hidden = true;
    renderLoginOptions();
    $("#login-password").focus();
  }

  function loginError(msg, focus) {
    const el = $("#login-error");
    el.classList.remove("info");
    el.textContent = msg;
    el.hidden = false;
    if (focus) $(focus).focus();
  }

  function showLogin() {
    $("#app").hidden = true;
    $("#login").hidden = false;
    closeDialog();
    login.pick = null; login.matches = []; login.active = -1;
    $("#login-name").value = "";
    $("#login-password").value = "";
    $("#login-error").hidden = true;
    renderLoginOptions();
    $("#login-name").focus();
  }

  function showApp() {
    const me = empById.get(db.me);
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#session").hidden = false;
    $("#session-who").innerHTML = `${avatar(me)}<span class="who"><span class="who-name">${esc(me.name)}</span><span class="who-meta">${esc(me.title || "GBL")}</span></span>`;
    ui.selected = null; ui.receivers = new Set(); ui.purpose = ""; ui.note = "";
    renderPurposes();
    resetDraft();
    const hash = location.hash.slice(1);
    setView(["request", "inbox", "sent", "mycards"].includes(hash) ? hash : "request");
    renderAll();
  }

  // ---------- 1. request: purpose ----------
  function renderPurposes() {
    $("#purpose-chips").innerHTML = PURPOSES.map((p) => `
      <button type="button" class="pchip" role="radio" aria-checked="${ui.purpose === p}" data-purpose="${esc(p)}">${esc(p)}</button>`).join("");
  }

  // ---------- 1. request: card list ----------
  function fillFilters() {
    const issuers = [...new Set(cards.map((c) => c.issuer))].sort();
    const cats = [...new Set(cards.map((c) => c.category))].sort();
    $("#issuer-filter").insertAdjacentHTML("beforeend", issuers.map((i) => `<option>${esc(i)}</option>`).join(""));
    $("#category-filter").insertAdjacentHTML("beforeend", cats.map((c) => `<option>${esc(c)}</option>`).join(""));
    $("#entry-bank").innerHTML = issuers.map((i) => `<option>${esc(i)}</option>`).join("");
  }

  function filteredCards() {
    const terms = norm(ui.query).split(" ").filter(Boolean);
    const out = [];
    for (const item of index) {
      const c = item.card;
      if (ui.issuer && c.issuer !== ui.issuer) continue;
      if (ui.category && c.category !== ui.category) continue;
      const n = holdersOf(c.id).length;
      if (ui.heldOnly && n === 0) continue;
      if (terms.length && !terms.every((t) => item.hay.includes(t))) continue;
      let score = n * 2;
      if (terms.length) {
        if (item.name.startsWith(terms[0])) score += 50;
        else if (item.name.includes(terms.join(" "))) score += 30;
      }
      out.push({ card: c, n, score });
    }
    out.sort((a, b) => b.score - a.score || a.card.issuer.localeCompare(b.card.issuer) || a.card.name.localeCompare(b.card.name));
    return { list: out, terms };
  }

  function renderList() {
    const { list, terms } = filteredCards();
    const ul = $("#card-list");
    const held = list.filter((r) => r.n > 0).length;
    $("#result-meta").textContent = list.length ? `${plural(list.length, "card")} · ${held} held by someone at GBL` : "";
    if (!list.length) {
      ul.innerHTML = `<li class="empty"><strong>No cards match “${esc(ui.query || "these filters")}”</strong>Try the bank name, a shorter word, or clear the filters.</li>`;
      return;
    }
    ul.innerHTML = list.map(({ card, n }) => `
      <li class="card-row" role="option" tabindex="0" data-id="${esc(card.id)}" aria-selected="${ui.selected === card.id}">
        ${mini(card)}
        <span class="row-text">
          <span class="row-name">${highlight(card.name, terms)}</span>
          <span class="row-issuer">${highlight(card.issuer, terms)}</span>
        </span>
        <span class="holders ${n ? "has" : ""}">${n ? plural(n, "holder") : "none"}</span>
      </li>`).join("");
  }

  // ---------- 1. request: detail + receivers ----------
  function renderDetail() {
    const el = $("#card-detail");
    const card = cardById.get(ui.selected);
    if (!card) {
      el.innerHTML = `<div class="detail-panel placeholder"><h2>Pick a card</h2><p>Choose a purpose, then search or pick a card to see which colleagues have it.</p></div>`;
      return;
    }
    const holders = holdersOf(card.id)
      .slice()
      .sort((a, b) => (ratingOf(b.id)?.avg || 0) - (ratingOf(a.id)?.avg || 0) || cardsOf(b.id).length - cardsOf(a.id).length || a.name.localeCompare(b.name));
    const others = holders.filter((e) => e.id !== db.me);
    const iHaveIt = holders.some((e) => e.id === db.me);
    for (const id of [...ui.receivers]) if (!others.some((e) => e.id === id)) ui.receivers.delete(id);

    const facts = [card.category, card.network || "Network varies by variant", card.coBranded ? "Co-branded" : ""]
      .filter(Boolean).map((f) => `<span class="chip-tag">${esc(f)}</span>`).join("");
    const link = card.url ? `<span class="chip-tag"><a href="${esc(card.url)}" target="_blank" rel="noopener">Issuer page ↗</a></span>` : "";

    const blockers = [];
    if (!db.me) blockers.push("choose your name at the top");
    if (!ui.purpose) blockers.push("pick a purpose");
    if (others.length && !ui.receivers.size) blockers.push("select at least one colleague");
    const canSend = !blockers.length && others.length > 0;

    el.innerHTML = `
      <div class="detail-panel">
        <div class="plastic${card.image ? " has-photo" : ""}" style="--card-bg:${cardBg(card)}">
          ${cardImg(card)}
          <div class="p-issuer">${esc(card.issuer)}</div>
          <div class="chip"></div>
          <div class="p-name">${esc(card.name)}</div>
          <div class="p-foot"><span>${esc(card.network || "CREDIT")}</span><span>${holders.length} at GBL</span></div>
        </div>
        <div class="facts">${facts}${link}</div>

        <div class="step">
          <h3 class="step-title"><span class="step-no">3</span>Choose who to ask</h3>
          ${others.length ? `
            <div class="select-all">
              <span class="note">${plural(others.length, "colleague has", "colleagues have")} this card${iHaveIt ? " (plus you)" : ""}. Everyone you tick gets the request, and the first to accept is matched.</span>
              <button type="button" class="linkish" id="toggle-all">${ui.receivers.size === others.length ? "Clear all" : "Select all"}</button>
            </div>
            <ul class="holder-list">${others.map((e) => `
              <li>
                <label class="holder pickable">
                  <input type="checkbox" data-receiver="${esc(e.id)}" ${ui.receivers.has(e.id) ? "checked" : ""}>
                  ${avatar(e)}
                  <span class="who">
                    <span class="who-name">${esc(e.name)} ${powerBadge(e)} ${ratingBadge(e.id)}</span>
                    <span class="who-meta">${esc(subtitle(e) || "GBL")} · ${plural(cardsOf(e.id).length, "card")}</span>
                  </span>
                </label>
              </li>`).join("")}</ul>
            <label class="field block">
              <span>Details (optional)</span>
              <textarea id="req-note" rows="2" placeholder="e.g. 10% off on a laptop on Amazon, about ₹85,000">${esc(ui.note)}</textarea>
            </label>
            <div class="send-row">
              <span class="note">${blockers.length ? `To send, ${blockers.join(", ")}.` : `Asking ${plural(ui.receivers.size, "colleague")} for ${esc(ui.purpose.toLowerCase())}.`}</span>
              <button type="button" class="btn primary" id="send-request" ${canSend ? "" : "disabled"}>Send request</button>
            </div>`
          : `<p class="note">${iHaveIt ? "You're the only one at GBL with this card." : "Nobody at GBL has added this card yet."} If you get it, add it in <strong>My cards</strong>.</p>`}
        </div>
      </div>`;
  }

  function selectCard(id, { scroll = false } = {}) {
    if (ui.selected !== id) {
      ui.selected = id;
      // Default: ask everyone who holds the card.
      ui.receivers = new Set(holdersOf(id).filter((e) => e.id !== db.me).map((e) => e.id));
    }
    for (const row of $$(".card-row")) row.setAttribute("aria-selected", row.dataset.id === id);
    renderDetail();
    if (scroll && window.matchMedia("(max-width: 820px)").matches) {
      $("#card-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function slackText(req, receiver) {
    const card = cardById.get(req.card);
    return `Hi ${receiver ? firstName(receiver) : "there"}, ${nameOf(req.from)} is looking for someone with the ${card.issuer} ${card.name}.\n` +
      `Purpose: ${req.purpose}${req.note ? `\nDetails: ${req.note}` : ""}\n` +
      `Can you help? Accept or decline in Card Finder. The first person to accept is matched.`;
  }

  // ---------- server + Slack ----------
  async function detectServer() {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 3000);
      const res = await fetch("api/config", { cache: "no-store", signal: ctl.signal });
      clearTimeout(timer);
      const cfg = res.ok ? await res.json() : {};
      mode.shared = cfg.shared === true;
      mode.slack = cfg.slack === true;
    } catch { mode.shared = false; mode.slack = false; }
    if (mode.shared) await refresh();
  }
  async function refresh() {
    try {
      const res = await fetch("api/state", { cache: "no-store" });
      if (res.ok && applyShared(await res.json())) return true;
    } catch { /* offline for a moment; try again next tick */ }
    return false;
  }
  // Pick up colleagues' changes. Don't re-render while someone is typing or a dialog is open.
  let pendingRender = false;
  function busy() {
    const a = document.activeElement;
    return !!openId || (a && a.matches("textarea, input[type=text], input[type=search], input[type=password]"));
  }
  function startPolling() {
    const tick = async () => {
      if (!db.me || document.hidden) return;
      if (await refresh()) { if (busy()) pendingRender = true; else renderAll(); }
    };
    setInterval(tick, 10000);
    window.addEventListener("focus", tick);
    document.addEventListener("focusout", () => setTimeout(() => {
      if (pendingRender && !busy()) { pendingRender = false; renderAll(); }
    }, 0));
  }
  function renderSlackMode() {
    $("#foot-mode").textContent = !mode.shared
      ? viaConnector()
        ? "Prototype: data is saved in this browser only. Slack DMs are sent from your own Slack via the claude.ai connector."
        : "Offline prototype: data is saved in this browser only. Slack messages are previews."
      : mode.slack
        ? "Shared with everyone at GBL. Requests are sent as Slack DMs."
        : "Shared with everyone at GBL. Slack isn't connected, so messages are previews.";
    $("#reset-data").hidden = mode.shared;
  }
  const SLACK_ERRORS = {
    channel_not_found: "Slack couldn't find this person",
    user_not_found: "Slack couldn't find this person",
    not_in_channel: "the Slack app can't message this person",
    invalid_auth: "the Slack token is invalid",
    missing_scope: "the Slack app is missing the chat:write permission",
    ratelimited: "Slack is rate limiting, try again in a minute",
  };
  const slackError = (code) => SLACK_ERRORS[code] || code || "unknown error";

  // ---------- Slack connector (claude.ai) ----------
  // On claude.ai the page can post through the viewer's own Slack connector, so the DM comes
  // from their Slack account. Used when there's no Card Finder server with a bot token.
  const SLACK_SERVER = "Slack";
  const SLACK_TOOL = "slack_send_message";
  const APP_LINK = window.CARD_FINDER_URL || "";
  let slackMcp = null;
  async function detectConnector() {
    try {
      if (!window.claude || typeof window.claude.use !== "function") return;
      slackMcp = await window.claude.use("mcp");
    } catch { slackMcp = null; }
    renderSlackMode();
  }
  const viaConnector = () => !!slackMcp && !mode.slack;

  // What each failure means for the person, and whether trying the next recipient can help.
  function connectorError(err) {
    const code = err && err.code;
    const map = {
      server_not_connected: ["Add the Slack connector in claude.ai Settings → Connectors, then send again.", true],
      needs_reauth: ["Your Slack connection has expired. Reconnect Slack in claude.ai Settings → Connectors, then send again.", true],
      selection_required: ["You have more than one Slack connection. Choose one when claude.ai asks, then send again.", true],
      not_in_manifest: ["Slack is turned off for this page. Allow Slack for Card Finder, then send again.", true],
      consent_required: ["Allow Slack for Card Finder when claude.ai asks, then send again.", true],
      blocked_by_policy: ["Your organization doesn't allow sending Slack messages from here.", true],
      approval_required: ["Your organization needs to approve each Slack message, which pages can't do yet.", true],
      not_granted: ["Slack isn't available on this page.", true],
      capability_disabled: ["Slack isn't available on this page.", true],
      capability_removed: ["Slack isn't available on this page.", true],
      server_unavailable: ["Slack didn't answer. The message may still have gone out, so check Slack before sending again.", true],
      upstream_error: ["Slack didn't answer. The message may still have gone out, so check Slack before sending again.", true],
      cancelled: ["Sending was cancelled.", true],
      tool_error: [`Slack refused it${err.message ? `: ${err.message}` : "."}`, false],
    };
    const [text, stop] = map[code] || [err?.message || "Something went wrong sending on Slack.", true];
    return { text, stop };
  }

  // A permalink if the connector returns one; its result shape isn't documented, so look for any Slack URL.
  function findLink(payload) {
    const m = JSON.stringify(payload ?? "").match(/https:\/\/[\w.-]+\.slack\.com\/archives\/[^"\s\\]+/);
    return m ? m[0] : "";
  }

  async function sendWithConnector(items) {
    const results = [];
    for (const item of items) {
      try {
        const res = await slackMcp.callTool(SLACK_SERVER, SLACK_TOOL, { channel_id: item.to, message: item.message });
        results.push({ to: item.to, ok: true, link: findLink(res.payload ?? res.content) });
      } catch (err) {
        const { text, stop } = connectorError(err);
        results.push({ to: item.to, ok: false, error: text });
        if (stop) {
          for (const rest of items.slice(results.length)) results.push({ to: rest.to, ok: false, error: "Not sent.", skipped: true });
          break;
        }
      }
    }
    return results;
  }

  // Slack messages in standard markdown for the connector, one per recipient.
  function connectorMessages(kind, req) {
    const card = cardById.get(req.card);
    const cardName = `${card.issuer} ${card.name}`;
    const link = APP_LINK ? `\n<${APP_LINK}|Open Card Finder>` : "";
    if (kind === "request") {
      return req.to.map((id) => ({
        to: id,
        message: [
          `Hi ${firstName(empById.get(id))}, I'm looking for someone with the **${cardName}** and saw on Card Finder that you have it.`,
          `**Purpose:** ${req.purpose}`,
          req.note ? `**Details:** ${req.note}` : "",
          `Could you help? Reply here, or accept in Card Finder.${req.to.length > 1 ? ` I've asked ${req.to.length} people; the first to accept is matched.` : ""}${link}`,
        ].filter(Boolean).join("\n"),
      }));
    }
    if (kind === "accepted") {
      return [{ to: req.from, message: `Hi ${firstName(empById.get(req.from))}, I can help with the **${cardName}** (${req.purpose.toLowerCase()}). Let's sort out the details here.${link}` }];
    }
    // done: the sender tells the helper
    return [{ to: req.matchedWith, message: `Thanks for helping with the **${cardName}**, ${firstName(empById.get(req.matchedWith))}! I've marked it done in Card Finder. Please rate me there when you get a moment.${link}` }];
  }

  // Dialog step: preview the DM(s), then send from the viewer's Slack on click.
  let pendingSlack = null; // { kind, req, items }
  function offerConnector(kind, req) {
    const items = connectorMessages(kind, req);
    pendingSlack = { kind, req, items };
    const names = items.map((i) => firstName(empById.get(i.to)));
    const me = empById.get(db.me);
    $("#slack-head").innerHTML = `${avatar(me)}<strong>${esc(me.name)}</strong><span class="app-tag">YOU</span>`;
    $("#slack-text").textContent = items[0].message.replace(/\*\*/g, "").replace(/<([^|>]+)\|([^>]+)>/g, "$2: $1");
    $("#slack-sub").textContent = items.length > 1 ? `One DM each to ${names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ")}` : `DM to ${names[0]}`;
    const status = $("#slack-status");
    status.className = "slack-status";
    status.textContent = "Sends from your own Slack account, using your Slack connector in claude.ai.";
    $("#slack-results").hidden = true;
    const send = $("#slack-send");
    send.hidden = false;
    send.disabled = false;
    send.textContent = items.length > 1 ? `Send ${items.length} DMs on Slack` : "Send on Slack";
    $("#slack-close").textContent = "Not now";
  }

  async function sendPendingSlack() {
    if (!pendingSlack || !slackMcp) return;
    const { items } = pendingSlack;
    const send = $("#slack-send");
    const status = $("#slack-status");
    send.disabled = true;
    send.textContent = "Sending…";
    status.className = "slack-status";
    status.textContent = `Sending to ${plural(items.length, "person", "people")}…`;
    const results = await sendWithConnector(items);
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    pendingSlack = null;
    send.hidden = true;
    $("#slack-close").textContent = "Done";
    $("#slack-title").textContent = !bad.length ? "Sent on Slack" : ok.length ? "Partly sent on Slack" : "Not sent on Slack";
    status.className = `slack-status ${bad.length ? "err" : "ok"}`;
    status.textContent = !bad.length
      ? `Sent from your Slack to ${ok.map((r) => firstName(empById.get(r.to))).join(", ")}.`
      : bad.find((r) => !r.skipped)?.error || "Not sent.";
    const list = $("#slack-results");
    list.hidden = results.length < 2 && !ok.some((r) => r.link);
    list.innerHTML = results.map((r) => {
      const e = empById.get(r.to);
      return `<li class="${r.ok ? "ok" : "err"}"><span>${r.ok ? "✓" : "✕"}</span> ${esc(e ? e.name : r.to)}${r.ok && r.link ? ` · <a href="${esc(r.link)}" target="_blank" rel="noopener">Open in Slack ↗</a>` : r.ok ? "" : ` · ${esc(r.skipped ? "not sent" : r.error)}`}</li>`;
    }).join("");
  }

  async function sendRequest() {
    const card = cardById.get(ui.selected);
    if (!card || !db.me || !ui.purpose || !ui.receivers.size) return;
    const btn = $("#send-request");
    if (btn) btn.disabled = true;
    const out = await run("createRequest", { card: card.id, purpose: ui.purpose, note: ui.note, to: [...ui.receivers] });
    if (!out) return;
    const req = out.result;
    ui.note = "";
    renderDetail();
    const names = req.to.map((id) => firstName(empById.get(id)));
    const list = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
    $("#slack-text").textContent = slackText(req, req.to.length === 1 ? empById.get(req.to[0]) : null);
    const status = $("#slack-status");
    status.className = "slack-status";
    $("#slack-send").hidden = true;
    $("#slack-results").hidden = true;
    $("#slack-close").textContent = "Done";
    $("#slack-head").innerHTML = `<span class="slack-bot">CF</span><strong>Card Finder</strong><span class="app-tag">APP</span>`;
    if (!out.slack && viaConnector()) {
      $("#slack-title").textContent = "Request saved. Send it on Slack?";
      offerConnector("request", req);
    } else if (!out.slack) {
      $("#slack-title").textContent = "Request sent";
      $("#slack-sub").textContent = `Slack DM to ${list}`;
      status.textContent = mode.shared
        ? `${list} can see it in their Card Finder inbox. Slack isn't connected, so copy this message to ping them.`
        : "Slack isn't connected here, so this is a preview. Copy it and send it yourself, or run Card Finder with its server to send it automatically.";
    } else {
      const sentTo = out.slack.results.filter((r) => r.ok).map((r) => firstName(empById.get(r.to)));
      const failed = out.slack.results.filter((r) => !r.ok);
      $("#slack-sub").textContent = `DM to ${list}`;
      if (out.slack.ok) {
        $("#slack-title").textContent = "Sent on Slack";
        status.classList.add("ok");
        status.textContent = `Delivered to ${sentTo.join(", ")}. They'll get a DM from the Card Finder app.`;
      } else {
        $("#slack-title").textContent = sentTo.length ? "Partly sent on Slack" : "Not sent on Slack";
        status.classList.add("err");
        status.textContent = failed.length
          ? `${sentTo.length ? `Sent to ${sentTo.join(", ")}. ` : ""}Couldn't reach ${failed.map((r) => `${firstName(empById.get(r.to))} (${slackError(r.error)})`).join(", ")}. The request is still in their inbox; copy the message to ping them.`
          : `Couldn't send: ${out.slack.error}. The request is still in their inbox; copy the message to ping them.`;
      }
    }
    openDialog("#slack-dialog");
  }

  // ---------- 2. inbox ----------
  function inboxItems() {
    return db.requests.filter((r) => r.to.includes(db.me) && r.from !== db.me).reverse();
  }
  function needsMe(r) {
    if (r.status === "open" && !r.declined.includes(db.me)) return true;
    return r.status === "done" && r.matchedWith === db.me && !r.ratings.byReceiver;
  }

  function reqCard(r, statusHtml, actionsHtml, extra = "") {
    const card = cardById.get(r.card);
    if (!card) return "";
    return `
      <li class="req">
        ${mini(card)}
        <div class="req-body">
          <div class="req-title">${esc(shortLabel(card))}</div>
          <div class="req-meta">${esc(r.purpose)} · ${when(r.createdAt)}</div>
          ${r.note ? `<p class="req-note">“${esc(r.note)}”</p>` : ""}
          <div class="req-status">${statusHtml}</div>
          ${extra}
        </div>
        <div class="req-actions">${actionsHtml}</div>
      </li>`;
  }

  function renderInbox() {
    const items = inboxItems();
    const pending = items.filter(needsMe).length;
    $("#inbox-count").hidden = !pending;
    $("#inbox-count").textContent = pending;
    const ul = $("#inbox-list");
    if (!db.me) { ul.innerHTML = `<li class="empty"><strong>Choose your name first</strong>Your inbox shows requests sent to you.</li>`; return; }
    if (!items.length) { ul.innerHTML = `<li class="empty"><strong>No requests yet</strong>When a colleague asks for one of your cards, it shows up here.</li>`; return; }
    ul.innerHTML = items.map((r) => {
      const from = empById.get(r.from);
      const by = `From <strong>${esc(nameOf(r.from))}</strong> ${from ? ratingBadge(from.id) : ""} ${slackLink(from)}`;
      if (r.status === "cancelled") return reqCard(r, `${by} · <span class="pill muted">Withdrawn</span>`, "");
      if (r.status === "open" && r.declined.includes(db.me)) return reqCard(r, `${by} · <span class="pill muted">You declined</span>`, "");
      if (r.status === "open") return reqCard(r, `${by} · <span class="pill wait">Waiting for a reply</span> <span class="note-inline">${plural(r.to.length, "person", "people")} asked</span>`,
        `<button class="btn ghost small" data-decline="${esc(r.id)}">Decline</button><button class="btn primary small" data-accept="${esc(r.id)}">Accept</button>`);
      if (r.matchedWith !== db.me) return reqCard(r, `${by} · <span class="pill muted">Closed: ${esc(firstName(empById.get(r.matchedWith)))} is helping</span>`, "");
      if (r.status === "matched") return reqCard(r, `${by} · <span class="pill ok">You're helping</span> <span class="note-inline">Use the card together offline. ${esc(firstName(from))} marks it done after.</span>`, "");
      const mine = r.ratings.byReceiver;
      return reqCard(r, `${by} · <span class="pill done">Done</span>`,
        mine ? `<span class="given" title="Your rating">You rated ${starsText(mine.stars)}</span>` : `<button class="btn primary small" data-rate="${esc(r.id)}" data-side="receiver">Rate ${esc(firstName(from))}</button>`);
    }).join("");
  }

  // ---------- 3. sent ----------
  function renderSent() {
    const items = db.requests.filter((r) => r.from === db.me).reverse();
    const active = items.filter((r) => r.status === "open" || r.status === "matched" || (r.status === "done" && !r.ratings.bySender)).length;
    $("#sent-count").hidden = !active;
    $("#sent-count").textContent = active;
    const ul = $("#sent-list");
    if (!db.me) { ul.innerHTML = `<li class="empty"><strong>Choose your name first</strong>This lists the requests you've sent.</li>`; return; }
    if (!items.length) { ul.innerHTML = `<li class="empty"><strong>You haven't sent any requests</strong>Go to Request a card, pick a purpose and a card, and ask the people who hold it.</li>`; return; }
    ul.innerHTML = items.map((r) => {
      const asked = r.to.map((id) => esc(firstName(empById.get(id)))).join(", ");
      const copy = `<button class="btn ghost small" data-copy="${esc(r.id)}">Copy Slack message</button>`;
      if (r.status === "cancelled") return reqCard(r, `<span class="pill muted">Withdrawn</span> <span class="note-inline">Asked ${asked}</span>`, "");
      if (r.status === "open") {
        const left = r.to.length - r.declined.length;
        const viaSlack = r.slack?.sentTo?.length ? ` · sent on Slack to ${r.slack.sentTo.length}` : "";
        const status = left
          ? `<span class="pill wait">Waiting</span> <span class="note-inline">Asked ${asked}${viaSlack}${r.declined.length ? ` · ${r.declined.length} declined` : ""}</span>`
          : `<span class="pill muted">Everyone declined</span> <span class="note-inline">Try another card or ask again later.</span>`;
        return reqCard(r, status, `${copy}<button class="btn ghost small" data-withdraw="${esc(r.id)}">Withdraw</button>`);
      }
      const helper = empById.get(r.matchedWith);
      if (r.status === "matched") {
        return reqCard(r, `<span class="pill ok">Matched with ${esc(helper?.name || "a colleague")}</span> ${slackLink(helper)} <span class="note-inline">Use the card together offline, then mark it done.</span>`,
          `<button class="btn primary small" data-done="${esc(r.id)}">Mark done</button>`);
      }
      const mine = r.ratings.bySender;
      return reqCard(r, `<span class="pill done">Done with ${esc(helper?.name || "a colleague")}</span>`,
        mine ? `<span class="given" title="Your rating">You rated ${starsText(mine.stars)}</span>` : `<button class="btn primary small" data-rate="${esc(r.id)}" data-side="sender">Rate ${esc(firstName(helper))}</button>`);
    }).join("");
  }

  // ---------- 4. my cards ----------
  let draft = null; // Set of card ids being edited
  function resetDraft() { draft = new Set(db.me ? cardsOf(db.me) : []); }
  function isDirty() {
    const saved = new Set(db.me ? cardsOf(db.me) : []);
    return saved.size !== draft.size || [...draft].some((id) => !saved.has(id));
  }
  function renderMyCards() {
    const form = $("#entry-form");
    const bank = $("#entry-bank").value;
    const list = cards.filter((c) => c.issuer === bank);
    const box = $("#entry-cards");
    box.disabled = !db.me;
    box.innerHTML = `<legend class="section-label">${esc(bank)} cards</legend>` + list.map((c) => `
      <label class="check">
        <input type="checkbox" data-own="${esc(c.id)}" ${draft.has(c.id) ? "checked" : ""}>
        ${mini(c)}
        <span>${esc(c.name)}<small>${esc(c.category)}</small></span>
      </label>`).join("");
    const dirty = db.me && isDirty();
    $("#entry-dirty").textContent = !db.me ? "Choose your name at the top first." : dirty ? "You have unsaved changes." : "";
    $("#entry-save").disabled = !dirty;
    form.classList.toggle("dirty", !!dirty);

    const owned = [...draft].map((id) => cardById.get(id)).filter(Boolean)
      .sort((a, b) => a.issuer.localeCompare(b.issuer) || a.name.localeCompare(b.name));
    $("#owned-title").textContent = db.me ? `Your cards (${owned.length})` : "Your cards";
    $("#owned-list").innerHTML = owned.length ? owned.map((c) => `
      <li>${mini(c)}<span>${esc(shortLabel(c))}</span>
      <button type="button" class="icon-btn" data-unown="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">×</button></li>`).join("")
      : `<li class="empty-inline">No cards yet. Tick the ones you hold and save.</li>`;
  }

  // ---------- dialogs ----------
  let openId = null;
  function openDialog(id) {
    openId = id;
    $("#scrim").hidden = false;
    $(id).hidden = false;
    const focusable = $(id).querySelector("button, textarea");
    if (focusable) focusable.focus();
  }
  let afterRate = null;
  function closeDialog() {
    if (!openId) return;
    const was = openId;
    $(openId).hidden = true;
    $("#scrim").hidden = true;
    openId = null;
    rating = null;
    if (was === "#slack-dialog") pendingSlack = null;
    if (was === "#rate-dialog" && afterRate) { const next = afterRate; afterRate = null; setTimeout(next, 0); }
  }

  let rating = null; // { req, side, stars }
  function openRate(reqId, side) {
    const r = db.requests.find((x) => x.id === reqId);
    if (!r) return;
    const other = side === "sender" ? empById.get(r.matchedWith) : empById.get(r.from);
    rating = { req: r, side, stars: 0 };
    $("#rate-title").textContent = `Rate ${other ? other.name : "your colleague"}`;
    $("#rate-sub").textContent = `${shortLabel(cardById.get(r.card))} · ${r.purpose}`;
    $("#rate-comment").value = "";
    renderStars();
    openDialog("#rate-dialog");
  }
  function renderStars() {
    const labels = ["Poor", "Fair", "Good", "Great", "Excellent"];
    $("#stars").innerHTML = labels.map((l, i) => `
      <button type="button" role="radio" class="star ${rating && i < rating.stars ? "on" : ""}" aria-checked="${rating?.stars === i + 1}" aria-label="${i + 1} star${i ? "s" : ""}, ${l}" data-star="${i + 1}">${STAR}</button>`).join("") +
      `<span class="star-label">${rating?.stars ? labels[rating.stars - 1] : "Tap a star"}</span>`;
    $("#rate-submit").disabled = !rating?.stars;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Message copied. Paste it in Slack."); }
    catch { toast("Copy isn't available here. Select the message text and copy it."); }
  }

  // ---------- views ----------
  function setView(view) {
    ui.view = view;
    for (const t of $$(".tab")) t.setAttribute("aria-selected", t.dataset.view === view);
    for (const v of $$(".view")) v.hidden = v.dataset.view !== view;
    renderView();
  }
  function renderView() {
    if (ui.view === "request") { renderList(); renderDetail(); }
    if (ui.view === "mycards") renderMyCards();
  }
  function renderAll() {
    recompute();
    renderInbox();
    renderSent();
    renderView();
    const holders = employees.filter((e) => cardsOf(e.id).length).length;
    $("#foot-stats").textContent = `${cards.length} cards from ${new Set(cards.map((c) => c.issuer)).size} issuers · ${employees.length} employees · ${holders} with cards`;
  }

  // ---------- events ----------
  function bind() {
    // Login
    const nameInput = $("#login-name");
    nameInput.addEventListener("input", () => {
      login.pick = null;
      login.matches = loginMatches(nameInput.value);
      login.active = login.matches.length ? 0 : -1;
      renderLoginOptions();
    });
    nameInput.addEventListener("keydown", (e) => {
      const n = login.matches.length;
      if (e.key === "ArrowDown" && n) { e.preventDefault(); login.active = (login.active + 1) % n; renderLoginOptions(); }
      else if (e.key === "ArrowUp" && n) { e.preventDefault(); login.active = (login.active - 1 + n) % n; renderLoginOptions(); }
      else if (e.key === "Enter" && n && login.active >= 0) { e.preventDefault(); pickLogin(login.matches[login.active].id); }
      else if (e.key === "Escape") { login.matches = []; renderLoginOptions(); }
    });
    nameInput.addEventListener("blur", () => setTimeout(() => { login.matches = []; renderLoginOptions(); }, 120));
    // mousedown so the pick lands before the input's blur closes the list
    $("#login-options").addEventListener("mousedown", (e) => {
      const opt = e.target.closest("[data-login]");
      if (opt) { e.preventDefault(); pickLogin(opt.dataset.login); }
    });
    $("#login-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!login.pick) {
        // Accept a typed name that matches exactly one person.
        const typed = norm(nameInput.value);
        const exact = employees.filter((x) => norm(x.name) === typed || norm(pickerLabel(x)) === typed);
        if (exact.length === 1) login.pick = exact[0].id;
      }
      if (!login.pick) return loginError(nameInput.value.trim() ? "Pick your name from the list." : "Enter your name.", "#login-name");
      if ($("#login-password").value !== PASSWORD) {
        $("#login-password").value = "";
        return loginError("Wrong password. Try again.", "#login-password");
      }
      db.me = login.pick;
      save();
      showApp();
      toast(`Welcome, ${firstName(empById.get(db.me))}.`);
    });
    $("#slack-login").addEventListener("click", () => {
      loginError("Slack sign-in isn't set up yet. Log in with your name and password for now.", "#login-name");
      $("#login-error").classList.add("info");
    });
    $("#logout").addEventListener("click", () => {
      db.me = "";
      save();
      showLogin();
    });

    $("#purpose-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-purpose]");
      if (!b) return;
      // A second click on the selected purpose clears it.
      ui.purpose = ui.purpose === b.dataset.purpose ? "" : b.dataset.purpose;
      renderPurposes();
      renderDetail();
    });

    $("#card-search").addEventListener("input", (e) => { ui.query = e.target.value; renderList(); });
    $("#card-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const first = $(".card-row"); if (first) selectCard(first.dataset.id, { scroll: true }); }
    });
    $("#issuer-filter").addEventListener("change", (e) => { ui.issuer = e.target.value; renderList(); });
    $("#category-filter").addEventListener("change", (e) => { ui.category = e.target.value; renderList(); });
    $("#held-only").addEventListener("change", (e) => { ui.heldOnly = e.target.checked; renderList(); });

    $("#card-list").addEventListener("click", (e) => {
      const row = e.target.closest(".card-row");
      if (row) selectCard(row.dataset.id, { scroll: true });
    });
    $("#card-list").addEventListener("keydown", (e) => {
      const row = e.target.closest(".card-row");
      if (!row) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectCard(row.dataset.id, { scroll: true }); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling;
        if (next && next.classList.contains("card-row")) next.focus();
      }
    });

    const detail = $("#card-detail");
    detail.addEventListener("change", (e) => {
      const box = e.target.closest("[data-receiver]");
      if (!box) return;
      if (box.checked) ui.receivers.add(box.dataset.receiver); else ui.receivers.delete(box.dataset.receiver);
      renderDetail();
    });
    detail.addEventListener("input", (e) => { if (e.target.id === "req-note") ui.note = e.target.value; });
    detail.addEventListener("click", (e) => {
      if (e.target.closest("#send-request")) return sendRequest();
      if (e.target.closest("#toggle-all")) {
        const others = holdersOf(ui.selected).filter((x) => x.id !== db.me).map((x) => x.id);
        ui.receivers = ui.receivers.size === others.length ? new Set() : new Set(others);
        renderDetail();
      }
    });

    document.addEventListener("click", (e) => {
      const t = e.target;
      const accept = t.closest("[data-accept]");
      if (accept) {
        run("accept", { id: accept.dataset.accept }).then((out) => {
          if (!out) return;
          const from = firstName(empById.get(out.result.from));
          if (!out.slack && viaConnector()) {
            $("#slack-title").textContent = `Accepted. Tell ${from} on Slack?`;
            offerConnector("accepted", out.result);
            openDialog("#slack-dialog");
            return;
          }
          toast(out.slack && !out.slack.ok
            ? `Accepted, but the Slack note to ${from} failed (${slackError(out.slack.results[0]?.error || out.slack.error)}).`
            : `Accepted. You're matched with ${from}. Use the card together offline.`);
        });
        return;
      }
      const decline = t.closest("[data-decline]");
      if (decline) {
        run("decline", { id: decline.dataset.decline }).then((out) => out && toast("Declined."));
        return;
      }
      const done = t.closest("[data-done]");
      if (done) {
        run("done", { id: done.dataset.done }).then((out) => {
          if (!out) return;
          // Rate first; offer the Slack thank-you after the rating dialog closes.
          if (!out.slack && viaConnector()) afterRate = () => {
            $("#slack-title").textContent = `Let ${firstName(empById.get(out.result.matchedWith))} know on Slack?`;
            offerConnector("done", out.result);
            openDialog("#slack-dialog");
          };
          openRate(out.result.id, "sender");
        });
        return;
      }
      const withdraw = t.closest("[data-withdraw]");
      if (withdraw) {
        run("withdraw", { id: withdraw.dataset.withdraw }).then((out) => out && toast("Request withdrawn."));
        return;
      }
      const rate = t.closest("[data-rate]");
      if (rate) return openRate(rate.dataset.rate, rate.dataset.side);
      const copy = t.closest("[data-copy]");
      if (copy) {
        const r = db.requests.find((x) => x.id === copy.dataset.copy);
        if (r) copyText(slackText(r, r.to.length === 1 ? empById.get(r.to[0]) : null));
        return;
      }
      if (t.closest("[data-close]") || t.id === "scrim") closeDialog();
    });

    for (const tab of $$(".tab")) tab.addEventListener("click", () => setView(tab.dataset.view));

    // My cards
    $("#entry-bank").addEventListener("change", renderMyCards);
    $("#entry-cards").addEventListener("change", (e) => {
      const box = e.target.closest("[data-own]");
      if (!box) return;
      if (box.checked) draft.add(box.dataset.own); else draft.delete(box.dataset.own);
      renderMyCards();
    });
    $("#owned-list").addEventListener("click", (e) => {
      const b = e.target.closest("[data-unown]");
      if (!b) return;
      draft.delete(b.dataset.unown);
      renderMyCards();
    });
    $("#entry-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!db.me) return;
      const had = cardsOf(db.me).length;
      run("setCards", { cards: [...draft] }).then((out) => {
        if (!out) return;
        resetDraft();
        renderMyCards();
        toast(had ? `Saved. You now have ${plural(draft.size, "card")}.` : `Saved ${plural(draft.size, "card")}. Colleagues can now find you.`);
      });
    });

    // Rating
    $("#stars").addEventListener("click", (e) => {
      const s = e.target.closest("[data-star]");
      if (!s || !rating) return;
      rating.stars = Number(s.dataset.star);
      renderStars();
    });
    $("#rate-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!rating?.stars) return;
      const { req, stars } = rating;
      const comment = $("#rate-comment").value;
      closeDialog();
      run("rate", { id: req.id, stars, comment }).then((out) => out && toast("Thanks. Your rating is saved."));
    });

    $("#slack-copy").addEventListener("click", () => copyText($("#slack-text").textContent));
    $("#slack-send").addEventListener("click", sendPendingSlack);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDialog(); });

    // Two-step reset (the viewer can't show confirm() dialogs)
    let armed = null;
    $("#reset-data").addEventListener("click", (e) => {
      const b = e.currentTarget;
      if (!armed) {
        b.textContent = "Click again to erase all cards, requests and ratings";
        armed = setTimeout(() => { armed = null; b.textContent = "Reset data"; }, 4000);
        return;
      }
      clearTimeout(armed); armed = null;
      db.holdings = {}; db.requests = [];
      save();
      b.textContent = "Reset data";
      resetDraft();
      renderAll();
      toast("All cards, requests and ratings erased.");
    });
  }

  // A photo that fails to load (offline, blocked host) falls back to the initials underneath.
  document.addEventListener("error", (e) => {
    if (!(e.target instanceof HTMLImageElement)) return;
    const box = e.target.parentElement;
    if (box?.classList.contains("avatar")) e.target.remove();
    if (box?.classList.contains("has-photo")) { e.target.remove(); box.classList.remove("has-photo"); }
  }, true);

  // ---------- boot ----------
  fillFilters();
  bind();
  (async () => {
    await detectServer();
    save();
    recompute();
    renderSlackMode();
    if (db.me) showApp(); else showLogin();
    if (mode.shared) startPolling();
    detectConnector();
  })();
})();
