# Card Finder

Find a GBL colleague who holds the credit card you need, and send them a request.

- **Cards**: running search across all 238 Indian credit cards in the catalogue (name, bank, short bank name like "Amex", and search aliases), or browse by bank and category. Pick a card to see everyone who holds it.
- **Request**: press *Request* next to a colleague, pick a purpose (offer, lounge, EMI, referral…), and Card Finder writes the message for you.
- **People**: every employee and their cards. The top 3 cardholders (ties included) get a **Power user** badge. Change `POWER_USER_TOP_N` in `app.js` to adjust.
- **My requests**: requests you have sent, with a copy button so you can paste the message into Slack.

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
| `data/employees.js` | **Dummy** employees. Replace with the real GBL list |

Update the cards after a new catalogue version:

```sh
pip install openpyxl
python3 scripts/import_cards.py data/Indian_Credit_Card_Catalogue_vX.xlsx
```

Each employee in `data/employees.js` looks like this. `cards` holds ids from `data/cards.js`:

```js
{ "id": "e001", "name": "Aarav Mehta", "team": "Design", "slack": "@aarav.mehta",
  "cards": ["hdfc-bank-irctc-hdfc-bank-credit-card", "sbi-card-air-india-sbi-signature-card"] }
```

## Current limits

- Requests are stored in the browser (localStorage). Nothing is sent to the colleague automatically yet.
- There is no login. The requester picks their name from a list, and it is remembered on that browser.
