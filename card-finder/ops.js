// Card Finder state changes, shared by the browser (offline mode) and server.js (shared mode),
// so both enforce the same rules, e.g. "the first person to accept is matched".
(function (root) {
  "use strict";

  const PURPOSES = [
    "Offer or discount on a purchase",
    "Airport lounge access",
    "EMI or no-cost EMI",
    "Referral to apply",
    "Advice before applying",
    "Something else",
  ];

  const emptyState = () => ({ holdings: {}, requests: [] });

  function fail(message, code = 400) {
    const err = new Error(message);
    err.status = code;
    throw err;
  }

  // ctx: { employees: Map, cards: Map, now: () => ISO string, newId: () => string }
  // Returns { result, notify } where notify lists Slack messages to send.
  function applyOp(state, op, args, ctx) {
    const by = args && args.by;
    if (!ctx.employees.has(by)) fail("Log in again: we don't recognise you.", 401);
    const find = (id) => state.requests.find((r) => r.id === id) || fail("That request no longer exists.", 404);

    switch (op) {
      case "setCards": {
        const ids = [...new Set(Array.isArray(args.cards) ? args.cards : [])];
        if (ids.length > 100) fail("That's more cards than we can save.");
        if (!ids.every((id) => ctx.cards.has(id))) fail("Some of those cards aren't in the catalogue.");
        state.holdings[by] = ids;
        return { result: ids, notify: [] };
      }

      case "createRequest": {
        const card = ctx.cards.get(args.card) || fail("Pick a card from the list.");
        if (!PURPOSES.includes(args.purpose)) fail("Pick a purpose.");
        const to = [...new Set(Array.isArray(args.to) ? args.to : [])].filter((id) => id !== by);
        if (!to.length) fail("Pick at least one colleague.");
        if (to.length > 50) fail("You can ask up to 50 people at once.");
        if (!to.every((id) => ctx.employees.has(id))) fail("Some of those people aren't at GBL.");
        const note = String(args.note || "").trim().slice(0, 500);
        const req = {
          id: ctx.newId(), from: by, card: card.id, purpose: args.purpose, note,
          to, declined: [], status: "open", matchedWith: null, createdAt: ctx.now(), ratings: {},
        };
        state.requests.push(req);
        return { result: req, notify: [{ type: "request", from: by, to, cardId: card.id, purpose: req.purpose, note }] };
      }

      case "accept": {
        const r = find(args.id);
        if (!r.to.includes(by)) fail("This request wasn't sent to you.", 403);
        if (r.status === "matched" || r.status === "done") fail("Someone else already accepted this request.", 409);
        if (r.status !== "open") fail("This request was withdrawn.", 409);
        r.status = "matched";
        r.matchedWith = by;
        r.matchedAt = ctx.now();
        r.declined = r.declined.filter((id) => id !== by);
        return { result: r, notify: [{ type: "accepted", from: by, to: [r.from], cardId: r.card }] };
      }

      case "decline": {
        const r = find(args.id);
        if (!r.to.includes(by)) fail("This request wasn't sent to you.", 403);
        if (r.status === "open" && !r.declined.includes(by)) r.declined.push(by);
        return { result: r, notify: [] };
      }

      case "done": {
        const r = find(args.id);
        if (r.from !== by) fail("Only the person who asked can mark this done.", 403);
        if (r.status !== "matched") fail("Only a matched request can be marked done.", 409);
        r.status = "done";
        r.doneAt = ctx.now();
        return { result: r, notify: [{ type: "done", from: by, to: [r.matchedWith], cardId: r.card }] };
      }

      case "withdraw": {
        const r = find(args.id);
        if (r.from !== by) fail("Only the person who asked can withdraw this.", 403);
        if (r.status !== "open") fail("Only a request nobody has accepted can be withdrawn.", 409);
        r.status = "cancelled";
        return { result: r, notify: [] };
      }

      case "rate": {
        const r = find(args.id);
        if (r.status !== "done") fail("You can rate once the request is done.", 409);
        const key = r.from === by ? "bySender" : r.matchedWith === by ? "byReceiver" : fail("You weren't part of this request.", 403);
        const stars = Number(args.stars);
        if (!Number.isInteger(stars) || stars < 1 || stars > 5) fail("Pick 1 to 5 stars.");
        if (r.ratings[key]) fail("You already rated this.", 409);
        r.ratings[key] = { stars, comment: String(args.comment || "").trim().slice(0, 300), at: ctx.now() };
        return { result: r, notify: [] };
      }

      default:
        fail("Unknown action.");
    }
  }

  const api = { PURPOSES, emptyState, applyOp };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CardOps = api;
})(this);
