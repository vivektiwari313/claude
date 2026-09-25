# Card Finder

Find a GBL colleague who holds the credit card you need, and borrow its benefit (offer, lounge, EMI, referral).

This is a **prototype**: the login is a dummy (search your name, password `12345` for everyone), data is saved in the browser, and Slack messages are shown as previews rather than sent.

**Login**: type your name and pick it from the suggestions, enter the password, and log in. *Log out* is at the top right.

**Request side**
1. **Purpose**: pick why you need the card. Click it again to clear it.
2. **Find the card**: running search across all 238 Indian credit cards (name, bank, short names like "Amex", aliases), or browse by bank and category.
3. **Choose who to ask**: everyone holding the card is listed and ticked by default. Send, and each gets a Slack DM (preview).
4. The **first colleague to accept** is matched; the request closes for everyone else.
5. Use the card together offline, then **Mark done** in *Sent*.
6. **Rate** each other 1–5 stars. Averages show next to names.

**Receiver side**: *Inbox* lists requests sent to you: Accept or Decline, then rate the sender once it's done.

**Input side**: *My cards*: pick a bank, tick the cards you hold from the checklist, and Save. Come back any time to update.

**Power user**: the top 3 cardholders (ties included, minimum 3 cards) get a badge next to their name in holder lists. Change `POWER_USER_TOP_N` and `POWER_USER_MIN_CARDS` in `app.js` to adjust.

## Run it

It's a static site with no build step. Open `index.html` in a browser, or serve the folder:

```sh
cd card-finder && python3 -m http.server 8000
```

## Data

| File | What it is |
| --- | --- |
| `data/Indian_Credit_Card_Catalogue_v0_5.xlsx` | Source card catalogue |
| `data/cards.js` | Generated from the xlsx. Don't edit by hand |
| `data/random_channel_members.json` | Slack member export (357 people from #random) |
| `data/employees.js` | Employees, generated from the Slack export. Everyone starts with no cards |

Update the cards after a new catalogue version:

```sh
pip install openpyxl
python3 scripts/import_cards.py data/Indian_Credit_Card_Catalogue_vX.xlsx
```

Update employees from a Slack member export (keeps cards already entered for matching ids):

```sh
python3 scripts/import_employees.py random_channel_members.json
```

Each employee in `data/employees.js` looks like this. `cards` holds ids from `data/cards.js`:

```js
{ "id": "U0123ABCD", "name": "Aarav Mehta", "title": "Designer", "slack": "@aarav.mehta",
  "cards": ["hdfc-bank-irctc-hdfc-bank-credit-card", "sbi-card-air-india-sbi-signature-card"] }
```

## Current limits

- Dummy login: one shared password (`PASSWORD` in `app.js`), checked in the browser. Anyone can log in as anyone.
- Cards, requests and ratings live in each browser's localStorage, so two people on different laptops don't see each other's data. A shared backend is the next step.
- Slack DMs are previews with a copy button. Sending them needs a Slack app (bot token).
