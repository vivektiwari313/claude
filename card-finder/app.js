(() => {
  "use strict";

  // Employees whose card count ranks in the top N (ties included) get the Power user badge.
  const POWER_USER_TOP_N = 3;
  const STORAGE = { requests: "cardfinder.requests", me: "cardfinder.me" };

  const cards = window.CARD_CATALOGUE || [];
  const employees = window.EMPLOYEES || [];
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const empById = new Map(employees.map((e) => [e.id, e]));

  // card id -> employees holding it
  const holdersByCard = new Map();
  for (const e of employees) {
    e.cards = e.cards.filter((id) => cardById.has(id));
    for (const id of e.cards) {
      if (!holdersByCard.has(id)) holdersByCard.set(id, []);
      holdersByCard.get(id).push(e);
    }
  }
  const holdersOf = (id) => holdersByCard.get(id) || [];

  const powerCutoff = (() => {
    const sorted = employees.map((e) => e.cards.length).sort((a, b) => b - a);
    return Math.max(1, sorted[Math.min(POWER_USER_TOP_N, sorted.length) - 1] || 1);
  })();
  const isPower = (e) => e.cards.length >= powerCutoff;

  // ---------- storage ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };
  let requests = store.get(STORAGE.requests, []);
  let me = store.get(STORAGE.me, "");

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9+ ]/g, " ").replace(/\s+/g, " ").trim();

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
  const initials = (name) => name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();

  function highlight(text, terms) {
    if (!terms.length) return esc(text);
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
    return esc(text).replace(re, "<mark>$1</mark>");
  }

  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 20.9l1.6-7L2 9.2l7.1-.6z"/></svg>';
  const powerBadge = (e) => (isPower(e) ? `<span class="power" title="Among the top ${POWER_USER_TOP_N} cardholders at GBL">${STAR}Power user</span>` : "");

  // Search index: name, issuer, aliases, short issuer name (e.g. "hdfc")
  const index = cards.map((c) => ({
    card: c,
    hay: norm([c.name, c.issuer, shortIssuer(c), ...(c.aliases || []), c.category, c.network].join(" ")),
    name: norm(c.name),
  }));

  // ---------- state ----------
  const state = { query: "", issuer: "", category: "", heldOnly: true, selected: null, view: "cards" };

  // ---------- filters ----------
  function fillFilters() {
    const issuers = [...new Set(cards.map((c) => c.issuer))].sort();
    const cats = [...new Set(cards.map((c) => c.category))].sort();
    $("#issuer-filter").insertAdjacentHTML("beforeend", issuers.map((i) => `<option>${esc(i)}</option>`).join(""));
    $("#category-filter").insertAdjacentHTML("beforeend", cats.map((c) => `<option>${esc(c)}</option>`).join(""));
  }

  function filteredCards() {
    const terms = norm(state.query).split(" ").filter(Boolean);
    const out = [];
    for (const item of index) {
      const c = item.card;
      if (state.issuer && c.issuer !== state.issuer) continue;
      if (state.category && c.category !== state.category) continue;
      const n = holdersOf(c.id).length;
      // A typed search looks across every card so people can see who has it, or that nobody does.
      if (state.heldOnly && !terms.length && n === 0) continue;
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

  // ---------- render: card list ----------
  function renderList() {
    const { list, terms } = filteredCards();
    const ul = $("#card-list");
    const heldCount = list.filter((r) => r.n > 0).length;
    $("#result-meta").textContent = list.length
      ? `${list.length} card${list.length === 1 ? "" : "s"} · ${heldCount} held by someone at GBL`
      : "";

    if (!list.length) {
      ul.innerHTML = `<li class="empty"><strong>No cards match “${esc(state.query || "these filters")}”</strong>Try the bank name, a shorter word, or clear the filters.</li>`;
      return;
    }
    ul.innerHTML = list.map(({ card, n }) => `
      <li class="card-row" role="option" tabindex="0" data-id="${esc(card.id)}" aria-selected="${state.selected === card.id}">
        <span class="mini" style="--card-bg:${cardBg(card)}"></span>
        <span class="row-text">
          <span class="row-name">${highlight(card.name, terms)}</span>
          <span class="row-issuer">${highlight(card.issuer, terms)}</span>
        </span>
        <span class="holders ${n ? "has" : ""}">${n ? `${n} ${n === 1 ? "holder" : "holders"}` : "none"}</span>
      </li>`).join("");
  }

  // ---------- render: detail ----------
  function requestButton(emp, card) {
    if (emp.id === me) return `<span class="chip-tag">You</span>`;
    const pending = requests.some((r) => r.to === emp.id && r.card === card.id && r.from === me);
    return pending
      ? `<button class="btn done small" disabled>Requested</button>`
      : `<button class="btn primary small" data-request="${esc(emp.id)}" data-card="${esc(card.id)}">Request</button>`;
  }

  function renderDetail() {
    const el = $("#card-detail");
    const card = cardById.get(state.selected);
    if (!card) {
      el.innerHTML = `<div class="detail-panel placeholder"><h2>Pick a card</h2><p>Search or choose a card from the list to see which colleagues have it.</p></div>`;
      return;
    }
    const holders = [...holdersOf(card.id)].sort((a, b) => b.cards.length - a.cards.length || a.name.localeCompare(b.name));
    const facts = [
      card.category,
      card.network ? card.network : "Network varies by variant",
      card.coBranded ? "Co-branded" : "",
    ].filter(Boolean).map((f) => `<span class="chip-tag">${esc(f)}</span>`).join("");
    const link = card.url ? `<span class="chip-tag"><a href="${esc(card.url)}" target="_blank" rel="noopener">Issuer page ↗</a></span>` : "";

    el.innerHTML = `
      <div class="detail-panel">
        <div class="plastic" style="--card-bg:${cardBg(card)}">
          <div class="p-issuer">${esc(card.issuer)}</div>
          <div class="chip"></div>
          <div>
            <div class="p-name">${esc(card.name)}</div>
          </div>
          <div class="p-foot"><span>${esc(card.network || "CREDIT")}</span><span>${holders.length} at GBL</span></div>
        </div>
        <div class="facts">${facts}${link}</div>
        <div>
          <h3 class="section-label">${holders.length ? `${holders.length} ${holders.length === 1 ? "colleague has" : "colleagues have"} this card` : "Nobody at GBL has this card yet"}</h3>
          ${holders.length ? `<ul class="holder-list">${holders.map((e) => `
            <li class="holder">
              <span class="avatar" style="--avatar-bg:${avatarBg(e)}">${initials(e.name)}</span>
              <span class="who">
                <span class="who-name">${esc(e.name)} ${powerBadge(e)}</span>
                <span class="who-meta">${esc(e.team)} · ${e.cards.length} card${e.cards.length === 1 ? "" : "s"}</span>
              </span>
              ${requestButton(e, card)}
            </li>`).join("")}</ul>` : `<p class="note">If you get this card, ask the Card Finder admin to add it to your profile.</p>`}
        </div>
      </div>`;
  }

  function selectCard(id, { scroll = false } = {}) {
    state.selected = id;
    for (const row of document.querySelectorAll(".card-row")) row.setAttribute("aria-selected", row.dataset.id === id);
    renderDetail();
    if (scroll && window.matchMedia("(max-width: 820px)").matches) {
      $("#card-detail").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ---------- render: people ----------
  function renderPeople() {
    const q = norm($("#people-search").value);
    const sort = $("#people-sort").value;
    let list = employees.filter((e) => !q || norm(`${e.name} ${e.team}`).includes(q));
    list.sort(sort === "name"
      ? (a, b) => a.name.localeCompare(b.name)
      : (a, b) => b.cards.length - a.cards.length || a.name.localeCompare(b.name));

    const powerCount = employees.filter(isPower).length;
    $("#power-note").textContent = `${employees.length} people · ${powerCount} power users (the top ${POWER_USER_TOP_N} cardholders, ${powerCutoff}+ cards).`;

    $("#people-grid").innerHTML = list.length ? list.map((e) => `
      <article class="person ${isPower(e) ? "is-power" : ""}">
        <div class="person-head">
          <span class="avatar" style="--avatar-bg:${avatarBg(e)}">${initials(e.name)}</span>
          <span class="who">
            <span class="who-name">${esc(e.name)} ${powerBadge(e)}</span>
            <span class="who-meta">${esc(e.team)} · ${esc(e.slack)}</span>
          </span>
          <span class="card-count">${e.cards.length}<small>cards</small></span>
        </div>
        <ul class="person-cards">${e.cards.map((id) => {
          const c = cardById.get(id);
          return `<li><button data-goto="${esc(id)}" title="${esc(c.issuer)} ${esc(c.name)}"><span class="dot" style="--card-bg:${cardBg(c)}"></span>${esc(shortLabel(c))}</button></li>`;
        }).join("")}</ul>
      </article>`).join("") : `<p class="empty"><strong>No one matches “${esc($("#people-search").value)}”</strong>Try a first name or a team.</p>`;
  }

  // ---------- render: requests ----------
  function messageFor(fromEmp, toEmp, card, purpose, note) {
    const first = toEmp.name.split(" ")[0];
    return `Hi ${first}, could you help me with your ${card.issuer} ${card.name}? Purpose: ${purpose}.${note ? ` ${note}` : ""} Thanks! (${fromEmp ? fromEmp.name : "A colleague"}, via Card Finder)`;
  }

  function renderRequests() {
    const pill = $("#req-count");
    pill.hidden = !requests.length;
    pill.textContent = requests.length;
    const ul = $("#req-list");
    if (!requests.length) {
      ul.innerHTML = `<li class="empty"><strong>No requests yet</strong>Open a card and press Request next to a colleague.</li>`;
      return;
    }
    ul.innerHTML = [...requests].reverse().map((r) => {
      const to = empById.get(r.to), card = cardById.get(r.card);
      if (!to || !card) return "";
      const when = new Date(r.at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
      return `
        <li class="req">
          <div>
            <div class="req-title">${esc(card.issuer)} ${esc(card.name)} → ${esc(to.name)}</div>
            <div class="req-meta">${esc(r.purpose)} · ${when} · Slack ${esc(to.slack)}</div>
          </div>
          <div class="req-actions">
            <button class="btn ghost small" data-copy="${esc(r.id)}">Copy message</button>
            <button class="btn ghost small" data-withdraw="${esc(r.id)}">Withdraw</button>
          </div>
          <p class="req-msg">${esc(r.message)}</p>
        </li>`;
    }).join("");
  }

  // ---------- dialog ----------
  let draft = null;
  function openDialog(empId, cardId) {
    const to = empById.get(empId), card = cardById.get(cardId);
    draft = { to, card };
    $("#dlg-title").textContent = `Request ${card.name}`;
    $("#dlg-sub").textContent = `From ${to.name} (${to.team}) · ${card.issuer}`;
    const sel = $("#req-from");
    sel.innerHTML = `<option value="" disabled ${me ? "" : "selected"}>Choose your name</option>` +
      [...employees].sort((a, b) => a.name.localeCompare(b.name))
        .filter((e) => e.id !== to.id)
        .map((e) => `<option value="${esc(e.id)}" ${e.id === me ? "selected" : ""}>${esc(e.name)}</option>`).join("");
    $("#req-note").value = "";
    updatePreview();
    $("#scrim").hidden = false;
    $("#request-dialog").hidden = false;
    (me ? $("#req-purpose") : sel).focus();
  }
  function closeDialog() {
    $("#scrim").hidden = true;
    $("#request-dialog").hidden = true;
    draft = null;
  }
  function updatePreview() {
    if (!draft) return;
    const from = empById.get($("#req-from").value);
    $("#req-preview").textContent = messageFor(from, draft.to, draft.card, $("#req-purpose").value, $("#req-note").value.trim());
  }

  let toastTimer;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Message copied. Paste it in Slack."); }
    catch { toast("Copy isn't available here. Select the message text and copy it."); }
  }

  // ---------- views ----------
  function setView(view) {
    state.view = view;
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", t.dataset.view === view);
    for (const v of document.querySelectorAll(".view")) v.hidden = v.dataset.view !== view;
    if (view === "people") renderPeople();
    if (view === "requests") renderRequests();
  }

  // ---------- events ----------
  function bind() {
    $("#card-search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
    $("#card-search").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const first = $(".card-row"); if (first) selectCard(first.dataset.id, { scroll: true }); }
    });
    $("#issuer-filter").addEventListener("change", (e) => { state.issuer = e.target.value; renderList(); });
    $("#category-filter").addEventListener("change", (e) => { state.category = e.target.value; renderList(); });
    $("#held-only").addEventListener("change", (e) => { state.heldOnly = e.target.checked; renderList(); });

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

    document.addEventListener("click", (e) => {
      const req = e.target.closest("[data-request]");
      if (req) return openDialog(req.dataset.request, req.dataset.card);
      const go = e.target.closest("[data-goto]");
      if (go) {
        setView("cards");
        state.query = ""; $("#card-search").value = "";
        const card = cardById.get(go.dataset.goto);
        state.issuer = ""; $("#issuer-filter").value = "";
        state.category = ""; $("#category-filter").value = "";
        renderList();
        selectCard(card.id);
        const row = document.querySelector(`.card-row[data-id="${CSS.escape(card.id)}"]`);
        if (row) row.scrollIntoView({ block: "nearest" });
        return;
      }
      const copy = e.target.closest("[data-copy]");
      if (copy) { const r = requests.find((x) => x.id === copy.dataset.copy); if (r) copyText(r.message); return; }
      const wd = e.target.closest("[data-withdraw]");
      if (wd) {
        requests = requests.filter((x) => x.id !== wd.dataset.withdraw);
        store.set(STORAGE.requests, requests);
        renderRequests(); renderDetail();
        toast("Request withdrawn.");
      }
    });

    for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => setView(t.dataset.view));
    $("#people-search").addEventListener("input", renderPeople);
    $("#people-sort").addEventListener("change", renderPeople);

    for (const id of ["#req-from", "#req-purpose", "#req-note"]) $(id).addEventListener("input", updatePreview);
    $("#dlg-cancel").addEventListener("click", closeDialog);
    $("#scrim").addEventListener("click", closeDialog);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && draft) closeDialog(); });

    $("#request-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (!draft) return;
      const fromId = $("#req-from").value;
      if (!fromId) { $("#req-from").focus(); toast("Choose your name first."); return; }
      me = fromId;
      store.set(STORAGE.me, me);
      const from = empById.get(fromId);
      const message = messageFor(from, draft.to, draft.card, $("#req-purpose").value, $("#req-note").value.trim());
      requests.push({
        id: `r${Date.now().toString(36)}`, from: fromId, to: draft.to.id, card: draft.card.id,
        purpose: $("#req-purpose").value, message, at: new Date().toISOString(),
      });
      store.set(STORAGE.requests, requests);
      const name = draft.to.name.split(" ")[0];
      closeDialog();
      renderDetail(); renderRequests();
      toast(`Request to ${name} saved. Find it in My requests to copy the message.`);
    });
  }

  // ---------- boot ----------
  fillFilters();
  bind();
  renderList();
  // Open on the most-held card so the first view shows how it works.
  const top = [...holdersByCard.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  selectCard(top ? top[0] : null);
  renderRequests();
  $("#foot-stats").textContent = `${cards.length} cards from ${new Set(cards.map((c) => c.issuer)).size} issuers · ${employees.length} employees`;
})();
