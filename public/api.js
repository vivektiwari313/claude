// Frontend data access for the server version. The standalone build swaps this file for
// one that searches an embedded copy of the database instead.
'use strict';

window.UserApi = {
  async search(query) {
    const res = await fetch(`/api/users/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    return res.json();
  },
};
