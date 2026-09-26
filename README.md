# User Search

A small web app with a searchable directory of 400 users.

- **Backend** (`server/`): zero-dependency Node.js HTTP server. The user database lives in
  `data/users.json`: 400 users, each with a unique name and an SVG display picture.
- **Frontend** (`public/`): a search bar that shows live suggestions as you type. Pick a user
  to see their name and a large display picture, with six clickable circular weapon buttons
  (Hammer, Shoe, Egg, Chain Saw, Gun, Pen) below it. Pick a weapon and use it on the picture:

  | Weapon | Effect |
  | --- | --- |
  | Hammer | The pointer becomes a big hammer that swings on each click. There's no limit: the first hits crack the picture, each more than the last; from the 6th, chunks of glass break out and fall away while the picture gets more battered; every 10th hit smashes the whole picture. |
  | Shoe | Flies in and leaves a muddy shoe print for 3 seconds. |
  | Egg | Splatters on the picture; the mess stays for 3 seconds. |
  | Chain Saw | Drag to cut the picture. Cuts stay until 3 seconds after you let go. |
  | Gun | Each click fires a shotgun blast of bullet holes. |
  | Pen | Drag to scribble in red. Lines stay until 3 seconds after you let go. |

  Starting a new chain saw or pen drag within those 3 seconds keeps the earlier marks. The
  **Reset** button clears everything, and so does picking a different user. Every weapon has a
  sound effect, generated in the browser so no audio files are needed; the speaker button next to **Reset** mutes them. The hammer stages and
  timings are in `CONFIG` at the top of `public/effects.js`; the sounds are in `public/sounds.js`.

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
node scripts/fetch-photos.js                          # download each avatar_url into it
python3 scripts/shrink-photos.py                      # optional, needs Pillow: shrink photos ~10x
node scripts/build-standalone.js --members            # -> private/user-search.html
node server/index.js                                  # server now serves the imported members
```

The input is `{ "members": [...] }` or a plain array, where each member has a `name` and an
optional `avatar_url`. Only the name and photo are kept.

`fetch-photos.js` downloads each member's photo (the 512px version for Slack and Gravatar) and
stores it, so the built file shows the real photos anywhere, offline included. Run it again to
retry any that failed; re-importing keeps photos whose URL hasn't changed. Slack's photos are
often large, so `shrink-photos.py` re-encodes them as 320px JPEGs; for ~350 members that takes
the file from about 90 MB to about 10 MB. Photos that weren't
downloaded are loaded from their URL when the page opens. Anyone with no photo, or whose
photo can't load, gets a generated picture instead.

To use a background photo, save it as `private/background.jpg` (a JPEG around 1600px wide
is plenty). The server shows it behind the page, and `build-standalone.js --members` embeds it;
it is dimmed and softened so the page stays readable.

`private/` is git-ignored so real people's data stays out of the repository; share the built
`private/user-search.html` file directly rather than committing it.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/users/search?q=<text>` | Up to 10 matches: `[{ id, name, picture, fallback }]` |
| `GET /api/users/:id` | One user: `{ id, name, picture, fallback }` |
| `GET /api/users/:id/photo` | The user's stored photo, when `fetch-photos.js` downloaded one |
| `GET /api/users/:id/picture` | The user's generated picture (`image/svg+xml`), also used as the fallback |

Search is case-insensitive. Names that start with the query come first, then names with a
word that starts with it, then any other name containing it.
