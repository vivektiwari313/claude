// Frontend data access for the server version. The standalone build swaps this file for
// one that searches an embedded copy of the database instead.
'use strict';

window.UserApi = {
  async search(query) {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    return res.json();
  },

  // Reports the player's first hit on a user; the server may DM them on Slack.
  async hit(id) {
    const res = await fetch(`/api/users/${id}/hit`, { method: 'POST', headers: { 'X-Whack-Hit': '1' } });
    return res.json();
  },
};
