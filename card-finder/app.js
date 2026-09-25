(() => {
  "use strict";

  // Employees whose card count ranks in the top N (ties included) get the Power user badge,
  // as long as they hold at least POWER_USER_MIN_CARDS cards.
  const POWER_USER_TOP_N = 3;
  const POWER_USER_MIN_CARDS = 3;
  const STORAGE_KEY = "cardfinder.v2";
  const PURPOSES = [
    "Offer or discount on a purchase",
    "Airport lounge access",
    "EMI or no-cost EMI",
    "Referral to apply",
    "Advice before applying",
    "Something else",
  ];

  const cards = window.CARD_CATALOGUE || [];
  const employees = (window.EMPLOYEES || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const empById = new Map(employees.map((e) => [e.id, e]));

  // ---------- persisted state ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch { /* storage unavailable */ }
    return {};
  }
  const db = Object.assign({ me: "", holdings: {}, requests: [] }, load());
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); } catch { /* storage unavailable */ }
  }
  // Drop anything saved for people who are no longer in the employee list (e.g. the old sample names).
  if (db.me && !empById.has(db.me)) db.me = "";
  for (const id of Object.keys(db.holdings)) if (!empById.has(id)) delete db.holdings[id];
  db.requests = db.requests.filter((r) => empById.has(r.from) && r.to.some((id) => empById.has(id)));

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

  // ---------- identity ----------
  function renderMe() {
    const sel = $("#me-select");
    sel.innerHTML = `<option value="">Choose your name</option>` +
      employees.map((e) => `<option value="${esc(e.id)}" ${e.id === db.me ? "selected" : ""}>${esc(pickerLabel(e))}</option>`).join("");
    $("#pick-me").hidden = !!db.me;
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
        <span class="mini" style="--card-bg:${cardBg(card)}"></span>
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
        <div class="plastic" style="--card-bg:${cardBg(card)}">
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

  function sendRequest() {
    const card = cardById.get(ui.selected);
    if (!card || !db.me || !ui.purpose || !ui.receivers.size) return;
    const req = {
      id: `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      from: db.me, card: card.id, purpose: ui.purpose, note: ui.note.trim(),
      to: [...ui.receivers], declined: [], status: "open", matchedWith: null,
      createdAt: new Date().toISOString(), ratings: {},
    };
    db.requests.push(req);
    save();
    ui.note = "";
    renderAll();
    const names = req.to.map((id) => firstName(empById.get(id)));
    $("#slack-sub").textContent = `Slack DM to ${names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ")}`;
    $("#slack-text").textContent = slackText(req, req.to.length === 1 ? empById.get(req.to[0]) : null);
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
        <span class="mini" style="--card-bg:${cardBg(card)}"></span>
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
        const status = left
          ? `<span class="pill wait">Waiting</span> <span class="note-inline">Asked ${asked}${r.declined.length ? ` · ${r.declined.length} declined` : ""}</span>`
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
        <span class="mini" style="--card-bg:${cardBg(c)}"></span>
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
      <li><span class="mini" style="--card-bg:${cardBg(c)}"></span><span>${esc(shortLabel(c))}</span>
      <button type="button" class="icon-btn" data-unown="${esc(c.id)}" aria-label="Remove ${esc(c.name)}">×</button></li>`).join("")
      : `<li class="empty-inline">No cards yet. Tick the ones you hold and save.</li>`;
  }

  // ---------- 5. people ----------
  function renderPeople() {
    const q = norm($("#people-search").value);
    const sort = $("#people-sort").value;
    const withCards = $("#people-with-cards").checked;
    const list = employees.filter((e) => (!q || norm(`${e.name} ${e.title || e.team || ""} ${e.slack || ""}`).includes(q)) && (!withCards || cardsOf(e.id).length));
    const byName = (a, b) => a.name.localeCompare(b.name);
    list.sort(sort === "name" ? byName
      : sort === "rating" ? (a, b) => (ratingOf(b.id)?.avg || 0) - (ratingOf(a.id)?.avg || 0) || byName(a, b)
      : (a, b) => cardsOf(b.id).length - cardsOf(a.id).length || byName(a, b));

    const holders = employees.filter((e) => cardsOf(e.id).length).length;
    const powerCount = employees.filter(isPower).length;
    $("#power-note").textContent = `${plural(employees.length, "person", "people")} · ${holders} have added cards` +
      (powerCount ? ` · ${plural(powerCount, "power user")} (top ${POWER_USER_TOP_N} cardholders, ${powerCutoff}+ cards)` : "");

    const grid = $("#people-grid");
    const shown = list.slice(0, 500);
    grid.innerHTML = shown.length ? shown.map((e) => {
      const own = cardsOf(e.id);
      return `
      <article class="person ${isPower(e) ? "is-power" : ""}">
        <div class="person-head">
          ${avatar(e)}
          <span class="who">
            <span class="who-name">${esc(e.name)}${e.id === db.me ? ' <span class="chip-tag">You</span>' : ""} ${powerBadge(e)}</span>
            <span class="who-meta">${esc(subtitle(e) || "GBL")} ${ratingBadge(e.id)}</span>
            ${slackLink(e)}
          </span>
          <span class="card-count">${own.length}<small>${own.length === 1 ? "card" : "cards"}</small></span>
        </div>
        ${own.length ? `<ul class="person-cards">${own.map((id) => {
          const c = cardById.get(id);
          return `<li><button data-goto="${esc(id)}" title="Request ${esc(c.issuer)} ${esc(c.name)}"><span class="dot" style="--card-bg:${cardBg(c)}"></span>${esc(shortLabel(c))}</button></li>`;
        }).join("")}</ul>` : `<p class="note">No cards added yet.</p>`}
      </article>`;
    }).join("") + (list.length > shown.length ? `<p class="note">Showing ${shown.length} of ${list.length}. Search to narrow down.</p>` : "")
      : `<p class="empty"><strong>No one matches</strong>Try a first name, or clear “Only people with cards”.</p>`;
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
  function closeDialog() {
    if (!openId) return;
    $(openId).hidden = true;
    $("#scrim").hidden = true;
    openId = null;
    rating = null;
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
    if (ui.view === "people") renderPeople();
  }
  function renderAll() {
    recompute();
    renderInbox();
    renderSent();
    renderView();
    const holders = employees.filter((e) => cardsOf(e.id).length).length;
    $("#foot-stats").textContent = `${cards.length} cards from ${new Set(cards.map((c) => c.issuer)).size} issuers · ${employees.length} employees · ${holders} with cards`;
  }

  function updateRequest(id, fn) {
    const r = db.requests.find((x) => x.id === id);
    if (!r) return null;
    fn(r);
    save();
    renderAll();
    return r;
  }

  // ---------- events ----------
  function bind() {
    $("#me-select").addEventListener("change", (e) => {
      db.me = e.target.value;
      save();
      renderMe();
      resetDraft();
      if (ui.selected) ui.receivers = new Set(holdersOf(ui.selected).filter((x) => x.id !== db.me).map((x) => x.id));
      renderAll();
      if (db.me) toast(`You're now using Card Finder as ${nameOf(db.me)}.`);
    });

    $("#purpose-chips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-purpose]");
      if (!b) return;
      ui.purpose = b.dataset.purpose;
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
        const r = db.requests.find((x) => x.id === accept.dataset.accept);
        if (!r || r.status !== "open") { toast("Someone else already accepted this request."); renderAll(); return; }
        updateRequest(r.id, (x) => { x.status = "matched"; x.matchedWith = db.me; x.matchedAt = new Date().toISOString(); });
        toast(`Accepted. You're matched with ${firstName(empById.get(r.from))}. Use the card together offline.`);
        return;
      }
      const decline = t.closest("[data-decline]");
      if (decline) {
        updateRequest(decline.dataset.decline, (x) => { if (!x.declined.includes(db.me)) x.declined.push(db.me); });
        toast("Declined.");
        return;
      }
      const done = t.closest("[data-done]");
      if (done) {
        const r = updateRequest(done.dataset.done, (x) => { x.status = "done"; x.doneAt = new Date().toISOString(); });
        if (r) openRate(r.id, "sender");
        return;
      }
      const withdraw = t.closest("[data-withdraw]");
      if (withdraw) {
        updateRequest(withdraw.dataset.withdraw, (x) => { x.status = "cancelled"; });
        toast("Request withdrawn.");
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
      const go = t.closest("[data-goto]");
      if (go) {
        ui.query = ""; $("#card-search").value = "";
        ui.issuer = ""; $("#issuer-filter").value = "";
        ui.category = ""; $("#category-filter").value = "";
        setView("request");
        selectCard(go.dataset.goto);
        const row = document.querySelector(`.card-row[data-id="${CSS.escape(go.dataset.goto)}"]`);
        if (row) row.scrollIntoView({ block: "nearest" });
        return;
      }
      if (t.closest("[data-close]") || t.id === "scrim") closeDialog();
    });

    for (const tab of $$(".tab")) tab.addEventListener("click", () => setView(tab.dataset.view));
    $("#people-search").addEventListener("input", renderPeople);
    $("#people-sort").addEventListener("change", renderPeople);
    $("#people-with-cards").addEventListener("change", renderPeople);

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
      db.holdings[db.me] = [...draft];
      save();
      renderAll();
      toast(had ? `Saved. You now have ${plural(draft.size, "card")}.` : `Saved ${plural(draft.size, "card")}. Colleagues can now find you.`);
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
      const { req, side, stars } = rating;
      const key = side === "sender" ? "bySender" : "byReceiver";
      updateRequest(req.id, (x) => { x.ratings[key] = { stars, comment: $("#rate-comment").value.trim(), at: new Date().toISOString() }; });
      closeDialog();
      toast("Thanks. Your rating is saved.");
    });

    $("#slack-copy").addEventListener("click", () => copyText($("#slack-text").textContent));
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
    if (e.target instanceof HTMLImageElement && e.target.parentElement?.classList.contains("avatar")) e.target.remove();
  }, true);

  // ---------- boot ----------
  fillFilters();
  renderMe();
  renderPurposes();
  resetDraft();
  bind();
  recompute();
  renderAll();
})();
