# User Search

A small web app with a searchable directory of 400 users.

- **Backend** (`server/`): zero-dependency Node.js HTTP server. The user database lives in
  `data/users.json`: 400 users, each with a unique name and an SVG display picture.
- **Frontend** (`public/`): a search bar that shows live suggestions as you type. Pick a user
  to see their name and a large display picture, with six clickable circular weapon buttons
  (Sword, Bow, Axe, Hammer, Spear, Dagger) below it.

## Run

```sh
npm start          # http://localhost:3000 (set PORT to change)
npm test           # API tests
npm run seed       # regenerate data/users.json (deterministic)
```

Requires Node.js 18+. There are no npm dependencies to install.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/users/search?q=<text>` | Up to 10 matches: `[{ id, name, picture }]` |
| `GET /api/users/:id` | One user: `{ id, name, picture }` |
| `GET /api/users/:id/picture` | The user's display picture (`image/svg+xml`) |

Search is case-insensitive. Names that start with the query come first, then names with a
word that starts with it, then any other name containing it.
