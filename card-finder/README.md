# Card Finder

Find a GBL colleague who holds the credit card you need, and borrow its benefit (offer, lounge, EMI, referral).

This is a **prototype**: the login is a dummy (search your name, password `12345` for everyone). Run it with `server.js` to share data across GBL and send real Slack DMs. Opened as a plain file, it saves data in the browser and shows Slack messages as previews.

**Login**: type your name and pick it from the suggestions, enter the password, and log in. *Log out* is at the top right. *Log in with Slack* is a placeholder for now.

**Request side**
1. **Purpose**: pick why you need the card. Click it again to clear it.
2. **Find the card**: running search across all 238 Indian credit cards (name, bank, short names like "Amex", aliases), or browse by bank and category.
3. **Choose who to ask**: everyone holding the card is listed and ticked by default. Send, and each gets a Slack DM from the Card Finder app (a preview when Slack isn't connected).
4. The **first colleague to accept** is matched; the request closes for everyone else, and the sender gets a Slack DM.
5. Use the card together offline, then **Mark done** in *Sent*.
6. **Rate** each other 1–5 stars. Averages show next to names.

**Referrals**
- When you save new cards in *My cards*, Card Finder asks whether to share a referral code, a referral link, or both, for each new card. Skip with *Not now*, and add or edit later with *Add referral code or link* next to any saved card.
- On a card, **Find a referral before applying** lists colleagues who shared one. **Copy code** copies it; **Open link ↗** opens the bank's page in a new tab (the site's domain is shown first). It sits below *Choose who to ask* as a secondary option, and only shows for cards you don't hold.
- Only `http(s)` links are accepted (bare domains get `https://` added), codes can't contain spaces, and removing a card removes its referral.

**Receiver side**: *Inbox* lists requests sent to you: Accept or Decline, then rate the sender once it's done.

**Input side**: *My cards*: pick a bank, tick the cards you hold from the checklist, and Save. Come back any time to update.

**Power user**: the top 3 cardholders (ties included, minimum 3 cards) get a badge next to their name in holder lists. Change `POWER_USER_TOP_N` and `POWER_USER_MIN_CARDS` in `app.js` to adjust.

## Hosting

- **GitHub Pages:** `.github/workflows/card-finder-pages.yml` publishes the app on every push to `main` that touches `card-finder/`. Turn it on once: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site is public, so it ships the **sample** employee list only. Data stays in each visitor's browser, and Slack messages are previews, because Pages can't run `server.js` or the claude.ai Slack connector.
- **claude.ai page:** the private artifact uses the real list and can send DMs through the viewer's Slack connector.
- **Your own server:** `server.js` (below) gives shared data and bot DMs.

## Run it

Quick look, no server: open `index.html` in a browser. Data stays in that browser and Slack messages show as previews.

With the server (shared data for everyone, and Slack DMs):

```sh
cd card-finder
node server.js                     # http://localhost:8000, Slack previews only
SLACK_BOT_TOKEN=xoxb-... APP_URL=https://cardfinder.example.com node server.js
```

`server.js` has no dependencies (Node 18+). It serves the app, keeps everyone's cards, requests and ratings in `data/state.json` (set `STATE_FILE` to move it), and sends the Slack DMs.

| Endpoint | What it does |
| --- | --- |
| `GET /api/config` | `{ "shared": true, "slack": true }`; the app switches to shared data, and to real DMs when a bot token is set |
| `GET /api/state` | Everyone's cards and requests. The app re-checks every 10 seconds and when you switch back to the tab |
| `POST /api/op` | One action: `setCards`, `setReferral`, `createRequest`, `accept`, `decline`, `done`, `withdraw`, `rate` |

The rules live in `ops.js`, which both the server and the offline page use. For example, the first person to accept is matched and anyone after gets "Someone else already accepted". Slack DMs go out as part of an action: `createRequest` DMs each receiver, `accept` DMs the sender, `done` DMs the helper. The server writes the text itself from ids it checks against `data/employees.js` and `data/cards.js`. Each DM has a button back to Card Finder (`APP_URL/#inbox` or `#sent`). If Slack fails, the action is still saved and the app says who couldn't be reached.

### Connect Slack

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**, pick the GBL workspace, and paste `slack-app-manifest.yml`.
2. **Install to Workspace** (a workspace admin may need to approve it).
3. Copy the **Bot User OAuth Token** (`xoxb-…`) from **OAuth & Permissions**.
4. Start the server with `SLACK_BOT_TOKEN` set, and `APP_URL` set to wherever people open Card Finder.

DMs arrive from the Card Finder app, addressed by Slack user id (the `id` in `data/employees.js`).

### Slack connector (claude.ai)

When Card Finder runs as a claude.ai artifact, it sends DMs through the viewer's own **Slack connector** instead of a bot. The DM comes from the viewer's Slack account.

- After *Send request* (and after *Accept* or *Mark done*), the dialog previews the DM and sends only when you click **Send on Slack**. *Not now* sends nothing.
- It calls the connector's `slack_send_message` tool with the colleague's Slack user id as `channel_id`, one DM per person.
- If Slack isn't connected, has expired, or is blocked for the page, it stops and tells you how to fix it. If one person fails, the others still get their DM, and the dialog lists who did.
- The page is published with the `mcp` capability for `Slack` / `slack_send_message` only. Each viewer is asked once to allow it.
- When `server.js` runs with a bot token, the bot is used instead.

## Card images

Cards show a drawn card until a real image is added. To add images:

1. Put each card's official image URL in `data/card-images.json`, keyed by card id: `{ "hdfc-bank-infinia-metal-edition": "https://…/infinia.png" }`.
2. `python3 scripts/fetch_card_images.py` downloads them into `images/cards/` and points the JSON at the local files.
3. `python3 scripts/import_cards.py data/Indian_Credit_Card_Catalogue_v0_5.xlsx` adds them to `data/cards.js`.

If an image fails to load, the app falls back to the drawn card.

## Data

| File | What it is |
| --- | --- |
| `data/Indian_Credit_Card_Catalogue_v0_5.xlsx` | Source card catalogue |
| `data/cards.js` | Generated from the xlsx. Don't edit by hand |
| `data/employees.js` | **Sample** employees (made-up names). Committed and published |
| `data/employees.local.js` | Real employees from the Slack export. **Git-ignored**, loads on top of the sample list when present |
| `data/card-images.json` | Optional card images, keyed by card id (see *Card images*) |
| `data/state.json` | Created by `server.js`: everyone's cards, requests and ratings. Not committed |

Update the cards after a new catalogue version:

```sh
pip install openpyxl
python3 scripts/import_cards.py data/Indian_Credit_Card_Catalogue_vX.xlsx
```

Load the real employees from a Slack member export. It writes `data/employees.local.js` and keeps cards already entered for matching ids. This repository is public, so keep the export outside it and never commit the output:

```sh
python3 scripts/import_employees.py ~/Downloads/random_channel_members.json
```

Each employee in `data/employees.js` looks like this. `cards` holds ids from `data/cards.js`:

```js
{ "id": "U0123ABCD", "name": "Aarav Mehta", "title": "Designer", "slack": "@aarav.mehta",
  "cards": ["hdfc-bank-irctc-hdfc-bank-credit-card", "sbi-card-air-india-sbi-signature-card"] }
```

## Current limits

- Dummy login: one shared password (`PASSWORD` in `app.js`), checked in the browser. The server trusts the name the page sends, so anyone can act as anyone.
- `POST /api/op` has an origin check but no real authentication. Keep the server on the internal network.
- Accept and decline happen in Card Finder, not with buttons inside Slack (those need a public URL for Slack's interactivity callbacks).
- *Log in with Slack* is a dummy button.
- With the Slack connector, the DM is sent from whoever is viewing the page, even if they logged in to Card Finder under another name.
- Card images aren't included yet; see *Card images*.
- Opened without the server, data stays in each browser and Slack messages are previews.
