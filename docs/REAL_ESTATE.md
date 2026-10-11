# Real estate add-on (QMULATE)

A business can be switched to a real-estate assistant by turning on one per-account feature, `real_estate`
(table `account_features`, read with `accountHasFeature(accountId, 'real_estate')`). The feature is always off for
account 1 and is on only for the QMULATE account. Everything below exists **only** while the feature is on: the menu,
the AI tools, the prompt section, the templates, the dashboard routes and the dashboard pages. Accounts without the
feature behave exactly as before (the real-estate API routes answer 404 and the pages are not in the sidebar).

## What the customer gets

Main menu (numbers are fixed, `0 Change Language` is appended to every main menu as before):

| # | Entry |
|---|-------|
| 1 | Buy |
| 2 | Sell |
| 3 | Explore Projects |
| 4 | Development & Investment |
| 5 | Real Estate Consultancy |
| 6 | Property / Asset Management |
| 7 | Book a Consultation |
| 8 | Speak to an Advisor (human hand-off) |
| 0 | Change Language |

Choosing a real-estate entry puts the conversation in a `REAL_ESTATE_CHAT` state so that numeric answers ("3 bedrooms",
"2") reach the AI instead of being read as menu numbers. The AI understands Arabic, English and mixed messages and
qualifies progressively (one or two questions at a time) instead of running a fixed form:

* buyers: purpose, property type, area, budget, timing, financing;
* sellers: property type, area, size, expectation, timing, ownership readiness.

Rules the assistant follows (prompt section `src/realestate/promptSection.ts`):

* it never invents projects, prices, availability, returns or legal advice; the company website publishes no projects,
  so **none are seeded**;
* projects are discussed only when staff have published them in the dashboard;
* no IBAN, card number or national-ID-like value is asked for or stored (these are rejected by the tool validator);
* a consultation request is recorded as a *request* and is never described as confirmed until the team confirms it;
* a human hand-off is offered on request and the existing hand-off flow is used;
* non-text inbound messages still get no reply (unchanged).

## Data (migration `023_real_estate.sql`, additive)

* `real_estate_projects` – staff-published projects (published/archived flags, brochure document reference);
* `real_estate_leads` – one open lead per customer and kind (partial unique index `uq_re_leads_one_open`), so a customer
  who comes back resumes the same enquiry instead of creating a duplicate;
* `real_estate_lead_projects` – projects a lead is interested in;
* `real_estate_lead_events` – audit trail of changes.

All rows carry `whatsapp_account_id`; every query is account-scoped. The assistant may only move a lead among
`new`, `awaiting_info`, `qualified`; staff statuses (contacted, consultation, closed, …) are never overwritten by it.

## AI tools (registered only for accounts with the feature)

| Tool | Purpose |
|------|---------|
| `save_real_estate_lead` | create/update the customer's open lead with the fields collected so far (validated; sensitive values rejected); alerts staff through the outbox with de-duplication |
| `search_real_estate_projects` | look up **published** projects of this account only |
| `send_project_brochure` | send a published project's brochure document of this account |

## Dashboard (QMULATE only)

Sidebar group REAL ESTATE: Overview, Leads (buyers / sellers / investors, lead detail with status, priority, follow-up
date, document status, next action, notes and assignee), Projects & Properties (create, edit, publish, archive),
Consultations & Follow-ups, and Documents (documents customers sent for this account). Numbers are masked, stored file
names are never shown, and every route is permission-checked (`authorize.ts`): projects use the `business` feature,
documents use `customers`, overview/leads/follow-ups use `requests`.

## Selected-account identity

The top bar, the line above the page title and the account list show the selected WhatsApp account's logo, name (Arabic
name in the Arabic interface), masked number and connection status. The data comes only from the server's
access-filtered accounts list (`logoUrl` is `/api/dashboard/accounts/:id/logo?v=<version>`, authorised per account),
and is redrawn on every account switch so a stale logo cannot remain. A missing or failing logo becomes a neutral initial
tile. Super Admin and multi-account users keep the SYNRTECHS identity in the sidebar; a user with exactly one account sees
that company. See `APPEARANCE_AND_BRANDING.md`.

## Upgrading an existing account

`scripts/upgradeAccount.ts` applies the QMULATE blueprint to an account that already exists without overwriting anything
staff edited (templates with a staff `updated_by`, business profile). It is a **dry run by default**:

```bash
npx tsx scripts/upgradeAccount.ts --blueprint qmulate                                  # preview only
npx tsx scripts/upgradeAccount.ts --blueprint qmulate --apply                          # write
npx tsx scripts/upgradeAccount.ts --blueprint qmulate --apply --overwrite-knowledge    # also rewrite knowledge files (each backed up first)
```

The script finds the account the blueprint belongs to; it takes no account id. Always rehearse on a copy of the database
and knowledge folder first (never against the live knowledge directory) and take a backup before `--apply`. Migration 023
and the new menu need a service restart.

## Known limits

* Staff alerts need `staff_whatsapp_number` (or a linked staff number) on the account; QMULATE has none yet, so alerts
  stay in the outbox until one is set.
* The account must still be paired by scanning the QR code; nothing here pairs or sends real WhatsApp messages.
