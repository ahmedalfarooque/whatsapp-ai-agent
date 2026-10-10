# Creating a new business account from a blueprint

A blueprint (`src/accounts/blueprint.ts`, `BusinessBlueprint`) describes a whole new WhatsApp business as data: name, business
profile, links, the guided menu, the customer-facing texts (Arabic and English) and the AI knowledge files.
`provisionBlueprint` turns it into a normal account with the same functions the dashboard uses. No account id is hard-coded.

Shipped blueprints live in `src/accounts/blueprints/` (currently `qmulate.ts`, QMULATE Real Estate Consultancy).

## What it does

- Creates **one** account: connection method QR, status `idle`, **no phone number, no JID**, its own empty Baileys auth directory
  `accounts/<id>/baileys-auth`. It becomes connected only when someone scans its QR code. No Meta Cloud API credentials are used.
- Saves the menu, seeds the account's own template set from that menu and publishes the customised texts, records the links,
  stores the logo (if a file is supplied) in the account's own uploads (internal, purpose `logo`) and saves the business profile.
  All database work is one transaction: a failure leaves no half-built account.
- Writes the AI knowledge files (`knowledge/accounts/<id>/`), only the ones that do not exist yet.
- Never touches another account, a session, the Super Admin or any credential.

## Running it

```
npx tsx scripts/provisionAccount.ts --blueprint qmulate [--logo <png/jpg/webp file>] [--dry-run]
```

Running it again does nothing: an account with the blueprint's exact name is recognised, and only missing knowledge files are
restored. Profile, menu and templates edited later in the dashboard are never overwritten. The logo is not committed to Git.

## After it ran

Open the dashboard, pick the new account in the account switcher (the permanent Super Admin sees every account, including new
ones; other users need the account assigned on the Users page), open **WhatsApp Connection** and scan the QR code with the
business phone. Opening hours, a Google Maps link, a staff alert number, offers and catalogues are left empty on purpose and can be
added in the dashboard when the business has them.
