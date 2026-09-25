# User Search

A small web app with a searchable directory of 400 users.

- **Backend** (`server/`): zero-dependency Node.js HTTP server. The user database lives in
  `data/users.json`: 400 users, each with a unique name and an SVG display picture.
- **Frontend** (`public/`): a search bar that shows live suggestions as you type. Pick a user
  to see their name and a large display picture, with six clickable circular weapon buttons
  (Sword, Bow, Axe, Hammer, Spear, Dagger) below it.

## Quick start: no install needed

Open **`standalone/user-search.html`** in any modern browser (double-click it). It is a single
self-contained file with the page, the styles and all 400 users with their pictures built in.
It needs no npm, no Node.js, no server and no internet connection. You can copy that one file
anywhere, email it, or put it on a USB stick.

## Run the server version (optional, needs Node.js 18+)

```sh
npm start          # http://localhost:3000 (set PORT to change)
npm test           # API tests
npm run seed       # regenerate data/users.json (deterministic)
npm run build      # rebuild standalone/user-search.html after changing public/ or data/
```

There are no npm dependencies to install; `node server/index.js` works just as well as `npm start`.

## Use your own member list (e.g. a Slack channel export)

```sh
node scripts/import-members.js path/to/members.json   # -> private/members.json
node scripts/build-standalone.js --members            # -> private/user-search.html
node server/index.js                                  # server now serves the imported members
```

The input is `{ "members": [...] }` or a plain array, where each member has a `name` and an
optional `avatar_url`. Only the name and photo link are kept. Photos are loaded from their
original URLs, so they need internet. Anyone with no photo, or whose photo can't load, gets a
generated picture instead.

`private/` is git-ignored so real people's data stays out of the repository; share the built
`private/user-search.html` file directly rather than committing it.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/users/search?q=<text>` | Up to 10 matches: `[{ id, name, picture, fallback }]` |
| `GET /api/users/:id` | One user: `{ id, name, picture, fallback }` |
| `GET /api/users/:id/picture` | The user's generated picture (`image/svg+xml`), also used as the fallback |

Search is case-insensitive. Names that start with the query come first, then names with a
word that starts with it, then any other name containing it.
