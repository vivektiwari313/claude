// Search ranking shared by the Node server and the standalone build.
// Ranks names that start with the query first, then names where any word starts with it,
// then any substring match. Ties are broken alphabetically.
(function (root) {
  'use strict';

  function rankUsers(users, rawQuery, limit) {
    const query = rawQuery.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!query) return [];

    const scored = [];
    for (const user of users) {
      const name = user.name.toLowerCase();
      let rank;
      if (name.startsWith(query)) rank = 0;
      else if (name.split(' ').some((word) => word.startsWith(query))) rank = 1;
      else if (name.includes(query)) rank = 2;
      else continue;
      scored.push({ rank, user });
    }

    scored.sort((a, b) => a.rank - b.rank || a.user.name.localeCompare(b.user.name));
    return scored.slice(0, limit).map(({ user }) => user);
  }

  if (typeof module === 'object' && module.exports) module.exports = { rankUsers };
  else root.rankUsers = rankUsers;
})(this);
