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
  const { PURPOSES, applyOp, cleanLink } = window.CardOps;

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
  const db = { me: read(SESSION_KEY) ?? saved.me ?? "", holdings: saved.holdings || {}, requests: saved.requests || [], referrals: saved.referrals || {} };
  function save() {
    write(SESSION_KEY, db.me);
    if (!mode.shared) write(STORAGE_KEY, { holdings: db.holdings, requests: db.requests, referrals: db.referrals });
  }
  function cleanUp() {
    // Drop anything saved for people who are no longer in the employee list (e.g. the old sample names).
    if (db.me && !empById.has(db.me)) db.me = "";
    for (const id of Object.keys(db.holdings)) if (!empById.has(id)) delete db.holdings[id];
    for (const id of Object.keys(db.referrals)) if (!empById.has(id)) delete db.referrals[id];
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
    db.referrals = state.referrals || {};
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

  // ---------- referrals ----------
  const refOf = (empId, cardId) => {
    const r = db.referrals[empId]?.[cardId];
    return r && cardsOf(empId).includes(cardId) && (r.code || r.link) ? r : null;
  };
  // Colleagues (not you) who shared a referral for this card, most recently updated first.
  const referrersOf = (cardId) => employees
    .filter((e) => e.id !== db.me && refOf(e.id, cardId))
    .sort((a, b) => (refOf(b.id, cardId).updatedAt || "").localeCompare(refOf(a.id, cardId).updatedAt || "") || a.name.localeCompare(b.name));
  // Re-check links before rendering them: only http(s) ever becomes an href.
  function safeLink(link) {
    try { return link ? cleanLink(link) : ""; } catch { return ""; }
  }
  const hostOf = (href) => { try { return new URL(href).hostname.replace(/^www\./, ""); } catch { return ""; } };
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
  // revealed: referral codes shown this session, as "employeeId:cardId"
  const ui = { revealed: new Set(), showRefs: false, query: "", issuer: "", category: "", heldOnly: false, selected: null, purpose: "", receivers: new Set(), note: "", view: "request" };

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
          <span class="row-issuer">${highlight(card.issuer, terms)}${referrersOf(card.id).length && !cardsOf(db.me).includes(card.id) ? ` · <span class="ref-count">${plural(referrersOf(card.id).length, "referral")}</span>` : ""}</span>
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
        ${referralSection(card, iHaveIt)}
      </div>`;
  }

  function referralSection(card, iHaveIt) {
    // Referrals help people apply for a card, so holders don't see this. They manage their own in My cards.
    if (iHaveIt) return "";
    const refs = referrersOf(card.id);
    const list = !ui.showRefs ? "" : refs.length ? `
      <ul class="ref-list">${refs.map((e) => {
        const r = refOf(e.id, card.id);
        const href = safeLink(r.link);
        return `
        <li class="ref">
          <div class="ref-who">${avatar(e)}
            <span class="who"><span class="who-name">${esc(e.name)} ${ratingBadge(e.id)}</span>
            <span class="who-meta">${esc(e.title || "GBL")}</span></span>
          </div>
          <div class="ref-actions">
            ${!r.code ? "" : ui.revealed.has(`${e.id}:${card.id}`)
              ? `<span class="ref-code" title="Referral code (copied)">${esc(r.code)}</span>`
              : `<button type="button" class="btn ghost small" data-show-code="${esc(e.id)}">Show code</button>`}
            ${href ? `<a class="btn primary small" href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow" title="${esc(href)}">Open link ↗</a>` : ""}
          </div>
          ${href ? `<p class="ref-leave">Opens <strong>${esc(hostOf(href))}</strong> in a new tab, outside Card Finder.</p>` : ""}
        </li>`;
      }).join("")}</ul>`
      : `<p class="note ref-empty">No one has shared a referral for this card yet.</p>`;
    return `
      <div class="ref-box${ui.showRefs ? " open" : ""}">
        <div class="ref-head">
          <span class="ref-label">Applying for this card yourself?</span>
          <button type="button" class="ref-toggle" id="find-ref" aria-expanded="${ui.showRefs}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10.6 13.4a1 1 0 0 1 0-1.4l3.4-3.4a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8 20a5 5 0 0 1-3.5-8.5l2.1-2.1a1 1 0 1 1 1.4 1.4l-2.1 2.1a3 3 0 1 0 4.2 4.2l2.1-2.1a1 1 0 1 1 1.4 1.4L11.5 18.6A5 5 0 0 1 8 20zm9.4-5.4a1 1 0 0 1-.7-1.7l2.1-2.1a3 3 0 1 0-4.2-4.2l-2.1 2.1a1 1 0 1 1-1.4-1.4l2.1-2.1a5 5 0 1 1 7.1 7.1l-2.1 2.1a1 1 0 0 1-.8.2z"/></svg>
            ${ui.showRefs ? "Hide referrals" : "Find a referral before applying"}
            <span class="ref-pill">${refs.length}</span>
          </button>
        </div>
        ${list}
      </div>`;
  }

  function selectCard(id, { scroll = false } = {}) {
    if (ui.selected !== id) {
      ui.selected = id;
      ui.showRefs = false;
      // Default: ask everyone who holds the card.
      ui.receivers = new Set(holdersOf(id).filter((e) => e.id !== db.me).map((e) => e.id));
    }
    for (const row of $$(".card-row")) row.setAttribute("aria-selected", row.dataset.id === id);
    renderDetail();
    if (scroll && window.matchMedia("(max-width: 820px)").matches) {
      $("#card-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // Suggested message for one person; the sender can edit it before sending.
  function defaultMessage(kind, req, to) {
    const card = cardById.get(req.card);
    const cardName = `${card.issuer} ${card.name}`;
    const first = firstName(empById.get(to));
    if (kind === "accepted") return `Hi ${first}, I can help with the ${cardName} (${req.purpose.toLowerCase()}). Let's sort out the details here.`;
    if (kind === "done") return `Thanks for helping with the ${cardName}, ${first}! I've marked it done in Card Finder. Please rate me there when you get a moment.`;
    return [
      `Hi ${first}, I'm looking for someone with the ${cardName} and saw on Card Finder that you have it.`,
      `Purpose: ${req.purpose}`,
      req.note ? `Details: ${req.note}` : "",
      `Could you help? Reply here, or accept in Card Finder.${req.to.length > 1 ? ` I've asked ${req.to.length} people; the first to accept is matched.` : ""}`,
    ].filter(Boolean).join("\n");
  }
  const messageFor = (req, to) => req.messages?.[to] || defaultMessage("request", req, to);

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

  // ---------- composer: one editable message per person ----------
  // A horizontal track of slides (swipe, arrows, dots, or ←/→). Used for new requests,
  // for Slack notes after Accept / Mark done, and to copy a sent request's messages.
  const composer = { items: [], defaults: [], index: 0, onConfirm: null, busy: false, done: false };

  function openComposer({ title, sub, items, confirmLabel, cancelLabel = "Cancel", onConfirm = null, readOnly = false, status = "" }) {
    composer.items = items.map((x) => ({ ...x }));
    composer.defaults = items.map((x) => x.suggested ?? x.message);
    composer.index = 0;
    composer.onConfirm = onConfirm;
    composer.busy = false;
    composer.done = readOnly;
    $("#compose-title").textContent = title;
    $("#compose-sub").textContent = sub || "";
    $("#compose-status").className = "slack-status";
    $("#compose-status").textContent = status;
    $("#compose-cancel").textContent = cancelLabel;
    const confirm = $("#compose-confirm");
    confirm.hidden = readOnly || !onConfirm;
    confirm.disabled = false;
    confirm.textContent = confirmLabel || "Send";
    const multi = composer.items.length > 1;
    $("#compose-dialog").classList.toggle("single", !multi);
    $("#compose-track").innerHTML = composer.items.map((it, i) => `
      <div class="slide" data-slide="${i}" role="group" aria-label="Message to ${esc(nameOf(it.to))}">
        <textarea id="compose-msg-${i}" rows="7" aria-label="Message to ${esc(nameOf(it.to))}" ${readOnly ? "readonly" : ""}>${esc(it.message)}</textarea>
        <div class="slide-foot">
          <span class="slide-result" id="compose-result-${i}"></span>
          <button type="button" class="linkish" data-reset="${i}" hidden>Reset to suggested</button>
          <button type="button" class="btn ghost small" data-copy-slide="${i}">Copy</button>
        </div>
      </div>`).join("");
    $("#compose-dots").innerHTML = multi ? composer.items.map((it, i) => `
      <button type="button" class="dot-btn" role="tab" data-dot="${i}" aria-label="${esc(nameOf(it.to))}" title="${esc(nameOf(it.to))}"></button>`).join("") : "";
    openDialog("#compose-dialog");
    $("#compose-track").scrollLeft = 0;
    renderComposerNav();
    if (!readOnly) $("#compose-msg-0")?.focus({ preventScroll: true });
  }

  function renderComposerNav() {
    const n = composer.items.length;
    const i = composer.index;
    const it = composer.items[i];
    if (!it) return;
    const e = empById.get(it.to);
    $("#compose-who").innerHTML = `${e ? avatar(e) : ""}
      <span class="who"><span class="who-name">${esc(nameOf(it.to))}</span>
      <span class="who-meta">${n > 1 ? `${i + 1} of ${n}` : esc(e?.title || "GBL")}${n > 1 && e?.title ? ` · ${esc(e.title)}` : ""}</span></span>`;
    $("#compose-prev").disabled = i === 0;
    $("#compose-next").disabled = i === n - 1;
    $("#compose-prev").hidden = $("#compose-next").hidden = n < 2;
    $$("#compose-dots .dot-btn").forEach((d, k) => {
      d.setAttribute("aria-selected", String(k === i));
      d.classList.toggle("edited", composer.items[k].message.trim() !== composer.defaults[k].trim());
      d.classList.toggle("sent", composer.items[k].result === "ok");
      d.classList.toggle("failed", composer.items[k].result === "err");
    });
    $$("#compose-track [data-reset]").forEach((b) => {
      const k = Number(b.dataset.reset);
      b.hidden = composer.done || composer.items[k].message.trim() === composer.defaults[k].trim();
    });
  }

  function composerGo(i, smooth = true) {
    const n = composer.items.length;
    composer.index = Math.max(0, Math.min(n - 1, i));
    const track = $("#compose-track");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({ left: composer.index * track.clientWidth, behavior: smooth && !reduce ? "smooth" : "auto" });
    renderComposerNav();
  }

  async function confirmComposer() {
    if (composer.busy || composer.done || !composer.onConfirm) return;
    const empty = composer.items.findIndex((it) => !it.message.trim());
    if (empty >= 0) {
      composerGo(empty);
      const st = $("#compose-status");
      st.className = "slack-status err";
      st.textContent = `Write a message for ${firstName(empById.get(composer.items[empty].to))}, or press Reset to use the suggested one.`;
      $(`#compose-msg-${empty}`)?.focus({ preventScroll: true });
      return;
    }
    composer.busy = true;
    const btn = $("#compose-confirm");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Sending…";
    $$("#compose-track textarea").forEach((t) => t.readOnly = true);
    const res = await composer.onConfirm(composer.items.map((it) => ({ to: it.to, message: it.message.trim() })));
    composer.busy = false;
    if (!res) {
      // Nothing saved (run() already explained why): let them fix it and try again.
      btn.disabled = false;
      btn.textContent = label;
      $$("#compose-track textarea").forEach((t) => t.readOnly = false);
      return;
    }
    composer.done = true;
    btn.hidden = true;
    $("#compose-cancel").textContent = "Done";
    $("#compose-title").textContent = res.title;
    $("#compose-sub").textContent = composer.items.length > 1 ? "Swipe or use the arrows to see what each person got. Copy any message to send it again." : "";
    const st = $("#compose-status");
    st.className = `slack-status ${res.cls || ""}`;
    st.textContent = res.status;
    for (const r of res.results || []) {
      const k = composer.items.findIndex((it) => it.to === r.to);
      if (k < 0) continue;
      composer.items[k].result = r.ok ? "ok" : "err";
      const el = $(`#compose-result-${k}`);
      el.className = `slide-result ${r.ok ? "ok" : "err"}`;
      el.innerHTML = r.ok
        ? `✓ Sent${r.link ? ` · <a href="${esc(r.link)}" target="_blank" rel="noopener">Open in Slack ↗</a>` : ""}`
        : `✕ ${esc(r.skipped ? "Not sent" : r.error || "Not sent")}`;
    }
    // Land on the first failure, if any, so it's the first thing they see.
    const firstBad = composer.items.findIndex((it) => it.result === "err");
    composerGo(firstBad >= 0 ? firstBad : composer.index, false);
  }

  const listNames = (ids) => {
    const names = ids.map((id) => firstName(empById.get(id)));
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  };
  const withLink = (text) => (APP_LINK ? `${text}\n<${APP_LINK}|Open Card Finder>` : text);

  // Sum up Slack delivery for the composer's done state.
  function slackSummary(results, how) {
    const ok = results.filter((r) => r.ok).map((r) => firstName(empById.get(r.to)));
    const bad = results.filter((r) => !r.ok);
    if (!bad.length) return { title: "Sent on Slack", cls: "ok", status: `Sent to ${ok.join(", ")}${how}.`, results };
    return {
      title: ok.length ? "Partly sent on Slack" : "Not sent on Slack",
      cls: "err",
      status: `${ok.length ? `Sent to ${ok.join(", ")}. ` : ""}${(bad.find((r) => !r.skipped)?.error || "Some messages weren't sent").replace(/([^.!?])$/, "$1.")} The request is still saved; you can copy the messages that didn't go.`,
      results,
    };
  }

  function sendRequest() {
    const card = cardById.get(ui.selected);
    if (!card || !db.me || !ui.purpose || !ui.receivers.size) return;
    const to = [...ui.receivers];
    const draftReq = { card: card.id, purpose: ui.purpose, note: ui.note.trim(), to };
    const items = to.map((id) => ({ to: id, message: defaultMessage("request", draftReq, id) }));
    const how = mode.slack
      ? "Each person gets their message as a Slack DM from the Card Finder app."
      : viaConnector()
        ? "Each person gets their message as a Slack DM from your own Slack account."
        : "Slack isn't connected here, so after saving you can copy each message and send it yourself.";
    openComposer({
      title: to.length > 1 ? `Review ${to.length} messages` : `Message to ${firstName(empById.get(to[0]))}`,
      sub: `${to.length > 1 ? "Swipe or use the arrows to check each person's message and edit any of them. " : ""}${how}`,
      items,
      confirmLabel: mode.slack || viaConnector() ? (to.length > 1 ? `Send ${to.length} messages` : "Send message") : "Save request",
      onConfirm: async (edited) => {
        const messages = Object.fromEntries(edited.map((it) => [it.to, it.message]));
        const out = await run("createRequest", { ...draftReq, messages });
        if (!out) return null;
        ui.note = "";
        renderDetail();
        if (out.slack) {
          const rs = (out.slack.results || []).map((r) => ({ ...r, error: r.ok ? undefined : slackError(r.error) }));
          if (!rs.length) return { title: "Request saved", cls: "err", status: `Couldn't send on Slack: ${out.slack.error}. It's in their Card Finder inbox; copy the messages to ping them.` };
          return slackSummary(rs, " from the Card Finder app");
        }
        if (viaConnector()) return slackSummary(await sendWithConnector(edited.map((it) => ({ to: it.to, message: withLink(it.message) }))), " from your Slack");
        return {
          title: "Request saved",
          status: mode.shared
            ? `${listNames(to)} can see it in their Card Finder inbox. Slack isn't connected, so copy each message to ping them.`
            : "Slack isn't connected here. Copy each message and send it yourself.",
        };
      },
    });
  }

  // After Accept / Mark done, offer a Slack note through the viewer's connector.
  function offerConnector(kind, req) {
    const to = kind === "accepted" ? req.from : req.matchedWith;
    const text = defaultMessage(kind, req, to);
    openComposer({
      title: kind === "accepted" ? `Accepted. Tell ${firstName(empById.get(to))} on Slack?` : `Let ${firstName(empById.get(to))} know on Slack?`,
      sub: "Sends from your own Slack account. Edit the message if you like.",
      items: [{ to, message: text }],
      confirmLabel: "Send on Slack",
      cancelLabel: "Not now",
      onConfirm: async (edited) => slackSummary(await sendWithConnector(edited.map((it) => ({ to: it.to, message: withLink(it.message) }))), " from your Slack"),
    });
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
      const copy = `<button class="btn ghost small" data-copy="${esc(r.id)}">${r.to.length > 1 ? "Copy messages" : "Copy message"}</button>`;
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
    const savedIds = new Set(db.me ? cardsOf(db.me) : []);
    $("#owned-list").innerHTML = owned.length ? owned.map((c) => {
      const r = savedIds.has(c.id) ? refOf(db.me, c.id) : null;
      const refLine = !savedIds.has(c.id)
        ? `<span class="owned-ref muted">Save to add a referral</span>`
        : r
          ? `<span class="owned-ref">Referral: ${[r.code ? `<code>${esc(r.code)}</code>` : "", safeLink(r.link) ? esc(hostOf(safeLink(r.link))) : ""].filter(Boolean).join(" · ")}
              <button type="button" class="linkish" data-edit-ref="${esc(c.id)}">Edit</button></span>`
          : `<span class="owned-ref"><button type="button" class="linkish" data-edit-ref="${esc(c.id)}">Add referral code or link</button></span>`;
      return `
      <li>${mini(c)}<span class="owned-text"><span>${esc(shortLabel(c))}</span>${refLine}</span>
      <button type="button" class="icon-btn" data-unown="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">×</button></li>`;
    }).join("")
      : `<li class="empty-inline">No cards yet. Tick the ones you hold and save.</li>`;
  }

  // ---------- referral dialog ----------
  let refEdit = null; // card ids being edited
  function openReferral(cardIds, { afterAdd = false } = {}) {
    refEdit = cardIds.filter((id) => cardById.has(id));
    if (!refEdit.length) return;
    const single = refEdit.length === 1;
    const first = cardById.get(refEdit[0]);
    $("#ref-title").textContent = afterAdd
      ? single ? `Share your ${shortLabel(first)} referral?` : "Share referrals for your new cards?"
      : `Referral for ${shortLabel(first)}`;
    $("#ref-sub").textContent = afterAdd
      ? "Colleagues looking to apply can use your referral code or link. Both are optional, and you can change them later in My cards."
      : "Add a referral code, a referral link, or both. Leave both empty to stop sharing.";
    $("#ref-rows").innerHTML = refEdit.map((id, i) => {
      const c = cardById.get(id);
      const r = refOf(db.me, id) || {};
      return `
      <fieldset class="ref-row" data-ref-card="${esc(id)}">
        <legend>${mini(c)}<span>${esc(shortLabel(c))}</span></legend>
        <label class="field">
          <span>Referral code</span>
          <input type="text" id="ref-code-${i}" data-ref="code" value="${esc(r.code || "")}" placeholder="e.g. AARTHI500" autocomplete="off" spellcheck="false" maxlength="60">
        </label>
        <label class="field">
          <span>Referral link</span>
          <input type="url" id="ref-link-${i}" data-ref="link" value="${esc(r.link || "")}" placeholder="https://…" autocomplete="off" spellcheck="false" maxlength="500">
        </label>
        <p class="ref-error" role="alert" hidden></p>
      </fieldset>`;
    }).join("");
    $("#ref-remove").hidden = afterAdd || !refOf(db.me, refEdit[0]);
    $("#ref-skip").textContent = afterAdd ? "Not now" : "Cancel";
    $("#ref-save").textContent = single ? "Save referral" : "Save referrals";
    openDialog("#ref-dialog");
    const firstInput = $("#ref-code-0");
    if (firstInput) firstInput.focus();
  }

  async function saveReferrals(clear = false) {
    if (!refEdit) return;
    const rows = $$("#ref-rows .ref-row");
    // Check everything first so no row is half-saved because a later one is invalid.
    const jobs = [];
    let bad = false;
    for (const row of rows) {
      const code = clear ? "" : row.querySelector('[data-ref="code"]').value.trim();
      const link = clear ? "" : row.querySelector('[data-ref="link"]').value.trim();
      const err = row.querySelector(".ref-error");
      err.hidden = true;
      try {
        if (/\s/.test(code)) throw new Error("Referral codes can't contain spaces.");
        if (link) cleanLink(link);
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        if (!bad) row.querySelector(link && !/\s/.test(code) ? '[data-ref="link"]' : '[data-ref="code"]').focus();
        bad = true;
        continue;
      }
      const card = row.dataset.refCard;
      const cur = refOf(db.me, card) || {};
      if ((cur.code || "") !== code || (cur.link || "") !== (link ? cleanLink(link) : "")) jobs.push({ card, code, link });
    }
    if (bad) return;
    let saved = 0;
    for (const job of jobs) {
      const out = await run("setReferral", job);
      if (!out) return; // run() already explained the problem
      saved++;
    }
    closeDialog();
    renderMyCards();
    if (clear) toast("Referral removed.");
    else if (saved) toast(saved === 1 ? "Referral saved. Colleagues can find it on the card." : `${saved} referrals saved.`);
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
    if (was === "#compose-dialog") { composer.onConfirm = null; composer.items = []; }
    if (was === "#ref-dialog") refEdit = null;
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
  async function copyText(text, done = "Message copied. Paste it in Slack.", failed = "Copy isn't available here. Select the message text and copy it.") {
    try { await navigator.clipboard.writeText(text); toast(done); }
    catch { toast(failed); }
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
      if (e.target.closest("#find-ref")) { ui.showRefs = !ui.showRefs; renderDetail(); return; }
      const show = e.target.closest("[data-show-code]");
      if (show) {
        // Reveal the code in place of the button and copy it straight away.
        const code = refOf(show.dataset.showCode, ui.selected)?.code;
        if (!code) return;
        ui.revealed.add(`${show.dataset.showCode}:${ui.selected}`);
        renderDetail();
        copyText(code, "Referral code copied.", "Code shown. Copy isn't available here, so select the code to copy it.");
        return;
      }
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
          if (!out.slack && viaConnector()) return offerConnector("accepted", out.result);
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
          if (!out.slack && viaConnector()) afterRate = () => offerConnector("done", out.result);
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
        if (r) openComposer({
          title: r.to.length > 1 ? "Messages for this request" : `Message to ${firstName(empById.get(r.to[0]))}`,
          sub: r.to.length > 1 ? "Swipe or use the arrows to see each person's message." : "",
          items: r.to.map((id) => ({ to: id, message: messageFor(r, id) })),
          readOnly: true,
          cancelLabel: "Done",
        });
        return;
      }
      const editRef = t.closest("[data-edit-ref]");
      if (editRef) { openReferral([editRef.dataset.editRef]); return; }
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
      const before = new Set(cardsOf(db.me));
      const had = before.size;
      run("setCards", { cards: [...draft] }).then((out) => {
        if (!out) return;
        resetDraft();
        renderMyCards();
        toast(had ? `Saved. You now have ${plural(draft.size, "card")}.` : `Saved ${plural(draft.size, "card")}. Colleagues can now find you.`);
        // Newly added cards: ask whether to share a referral for them.
        const added = out.result.filter((id) => !before.has(id));
        if (added.length) openReferral(added, { afterAdd: true });
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

    // Composer
    const track = $("#compose-track");
    $("#compose-confirm").addEventListener("click", confirmComposer);
    $("#compose-prev").addEventListener("click", () => composerGo(composer.index - 1));
    $("#compose-next").addEventListener("click", () => composerGo(composer.index + 1));
    $("#compose-dots").addEventListener("click", (e) => { const d = e.target.closest("[data-dot]"); if (d) composerGo(Number(d.dataset.dot)); });
    let scrollRaf = 0;
    track.addEventListener("scroll", () => {
      cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(() => {
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if (i !== composer.index && composer.items[i]) { composer.index = i; renderComposerNav(); }
      });
    });
    track.addEventListener("input", (e) => {
      const m = e.target.id && e.target.id.match(/^compose-msg-(\d+)$/);
      if (!m) return;
      composer.items[Number(m[1])].message = e.target.value;
      $("#compose-status").className = "slack-status";
      renderComposerNav();
    });
    track.addEventListener("click", (e) => {
      const reset = e.target.closest("[data-reset]");
      if (reset) {
        const k = Number(reset.dataset.reset);
        composer.items[k].message = composer.defaults[k];
        $(`#compose-msg-${k}`).value = composer.defaults[k];
        renderComposerNav();
        return;
      }
      const cp = e.target.closest("[data-copy-slide]");
      if (cp) copyText(composer.items[Number(cp.dataset.copySlide)].message.trim(), "Message copied. Paste it in Slack.");
    });
    $("#compose-dialog").addEventListener("keydown", (e) => {
      if (e.target.tagName === "TEXTAREA" || composer.items.length < 2) return;
      if (e.key === "ArrowRight") { e.preventDefault(); composerGo(composer.index + 1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); composerGo(composer.index - 1); }
    });
    window.addEventListener("resize", () => { if (openId === "#compose-dialog") composerGo(composer.index, false); });
    $("#ref-form").addEventListener("submit", (e) => { e.preventDefault(); saveReferrals(); });
    $("#ref-remove").addEventListener("click", () => saveReferrals(true));
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
  $("#sample-note").hidden = !window.EMPLOYEES_SAMPLE;
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
