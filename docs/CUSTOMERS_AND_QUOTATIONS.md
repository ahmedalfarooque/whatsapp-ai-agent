# Customers, Inquiry Cart, Quotations and Customer Reports

Everything here is per business (WhatsApp account): the original business, the second one and any added later behave the same, and nothing
is hard-coded to a business. Every query is scoped to the business; an id from another business is "not found".

## 1. Inquiry Cart (WhatsApp)

* Every business's **main menu** has an *Inquiry Cart* option. It is added when the menu is rendered (like the permanent *Change language*
  line) and takes the first number after the business's own items — **10** on the original business (nine options), **9** on a business with
  the default eight, and so on. Nothing is stored per business, so customised, regenerated and future menus all get it, in the customer's
  language, with no migration and no duplicate. `0` is untouched: *Change language* on the main menu, *back to the main menu* everywhere else.
  The old static "cart" page under Prices & Offers (option 5) now opens the same real cart.
* Steps: **view** the cart → **add** an item (free text, then an optional quantity — send a number or "skip") → **remove** an item (by
  number) → **review & submit** → **My inquiries & quotation status**. Items and quantities are exactly what the customer typed; no product
  or price is ever invented. A business with an empty cart (or no catalogue) still gets a **general inquiry**: one message becomes the request.
* Submitting creates ONE ordinary quotation request (`customer_requests`, kind `quotation`, reference `INQ-yyyy-nnnn`, `source = cart`) and
  closes the cart in the same transaction; staff get the usual new-request alert. An empty cart is never submitted. A customer has at most one
  open cart (database-enforced). Removed items stay on record (`removed_at`) so the timeline shows what was added and taken out.
* **Status check**: the customer sees only their **own** requests (matched by customer, business and reference). Someone else's reference,
  another business's reference and a made-up one all get the same "not found" answer. Internal notes are never included; the delivered
  quotation (total, validity) is shown once it was actually sent.
* All wording lives in the editable reply templates (`src/templates/cartDefaults.ts`, shown in the Manual Reply Editor and the flow map).

## 2. Quotation lifecycle

Statuses of a quotation request: `pending → preparing → approved → sent → completed / closed / expired`, with `rejected` / `cancelled`
before it is sent (and `cancelled` / `expired` after). Rules live in `src/requests/quotationLifecycle.ts`; appointments keep their old
free behaviour and never get the quotation-only statuses. The old status `confirmed` stays valid for existing rows and older callers.

| Status | Meaning |
| --- | --- |
| Pending | Received, nobody acted yet. |
| Preparing | Staff started a quotation draft. |
| Approved | Staff decided to quote. **The customer does not have the quotation yet.** The customer is told once ("approved"). |
| Sent | The quotation message was **accepted by WhatsApp** (or staff recorded, with a reason, that they sent it another way). Never a button. |
| Rejected / Cancelled | Final. Rejection needs a reason; the customer is told once. |
| Completed / Closed | Staff close-out after sending. |
| Expired | Set **automatically** when a *sent* quotation's validity date has passed (see *Automatic expiry* below), or by staff. |

* **Content**: staff prepare *versions* (`quotation_versions` + `quotation_lines`). A draft is editable; a finalised version is frozen — a change
  is a new version, and a sent version stays on record (version history is never rewritten). Only what staff supply is shown: price,
  quantity, currency, tax, validity and a message are optional; **a total exists only when every line has a quantity and a price** (otherwise
  it is absent, never 0). Money is integer minor units (2 decimals), quantities milli-units (3 decimals), computed with exact integer
  arithmetic; anything more precise is refused rather than rounded. The quote number is `<request reference>-Q<version>`.
* **Document**: staff may attach a PDF/image/Word file (stored as an outbound customer file). There is no PDF generator in this application;
  the quotation text itself is always sent as a formatted WhatsApp message (Arabic or English per the customer), and the attached file travels
  with it as a real WhatsApp document (the text is its caption when it fits, otherwise it follows as its own message).
* **Delivery** goes through the notification outbox (account-scoped, retries with backoff, idempotent per version, deferred while the account is
  offline). The request stays **Approved** while the message is queued or failing; it becomes **Sent** only after WhatsApp accepted it. A
  permanent failure is recorded on the request and never marks it sent. WhatsApp gives no delivered/read receipt through this connection,
  so "Sent" means *accepted by WhatsApp*, not *read*.
* **Audit**: every transition records who (dashboard user), when, the reason, and what the customer was told (`request_events`).
* **Customer notifications** fire only on real transitions, at most once per request and status (an unchanged status or a rollback to a status
  that already notified sends nothing). Wording: `quotation_approved`, `quotation_rejected`, `quotation_delivery`, `request_*` templates.

* **Automatic expiry** (`src/quotations/quotationExpiry.ts`): at start-up (after 20 s) and then hourly, every business is checked on its own
  timezone (Business settings; `BUSINESS_TIMEZONE` when not set). A quotation that is **sent** whose *delivered* version has a valid
  `YYYY-MM-DD` validity date **earlier than today in that timezone** becomes **expired** (the validity date itself is the last valid day). A
  quotation with no date or an invalid one, and anything in another status (preparing, approved, rejected, cancelled, completed, closed,
  already expired), is never touched. The move goes through the same transition code as every status change, so it is idempotent, writes an
  audit event (actor *system*, reason with the date and timezone, timestamp), keeps every version including the sent one, and **sends the
  customer nothing** (an expiry is bookkeeping; the staff alert is the usual status-change alert, once per event). If staff start a new
  version, the request leaves *sent* by itself and is no longer a candidate.

## 3. Customers section (dashboard → Customers CRM)

* **Directory**: search (name, number, company, email, reference), request status, language, follow-up state, open work, has documents, sort,
  pagination.
* **Profile**: name, number, language, editable company and email (staff-entered, never invented), counts, open cart, requests and quotations.
* **Timeline**: first contact, inquiries, cart changes (added / removed / submitted), status changes with who and why, quotation prepared /
  finalised / sent, documents received and sent, staff notes, follow-ups, asked-for-staff. Each event keeps its **original timestamp**, links to
  the request/quotation, to the file, and back to the **conversation** (plus the original WhatsApp message id for files). It is searchable and
  filterable by type and dates. The chat itself is not copied: the Conversations page remains its one home.
* **Documents**: files received from and sent to the customer — name, type, size, caption, related inquiry/quotation, direction, time,
  stored / failed / too large / unsupported, and for quotation documents the delivery state. Open/download is authorised per customer and
  business, served with `nosniff`, a restrictive CSP and `Cache-Control: private, no-store`, never reveals a server path, and only images and
  PDFs open inline (everything else downloads). Text read from a file is shown as **unverified customer content**; it is never put in the business
  library, the AI context, or used as policy.
* **PDF text extraction** (`src/files/fileTextExtraction.ts`, migration 022): after a PDF is stored, its text layer is read in the background (never
  delaying or answering the message) into its own column with a status (`text_extracted` / `extraction_failed`), timestamp, page count, error
  and attempt count. The original file is never changed. **No OCR**: a scanned PDF has no text layer, which is recorded as *text not read* and the
  file stays available to open and read by a person. Limits: the 10 MB file cap, 60 pages, 60,000 characters, a 20 s timeout, one file at a
  time (25 waiting at most), the PDF signature re-checked, the path confined to the business's own upload folder, a business can only read its own
  files, and at most 5 attempts per file. Staff with edit access can retry from the Documents tab (`POST /api/dashboard/customers/files/:id/extract`).
  The text is stored as inert data (control characters removed) and shown only to staff, labelled unverified; nothing in the AI code reads it
  (a test scans the source for that).
* **Receiving files**: pictures and documents a customer sends are captured (limit 10 MB, content checked against the type, one per WhatsApp
  message) and are **never answered** — a non-text message still gets no automatic reply. Video, audio, voice notes and stickers are recorded
  as unsupported. If identity is uncertain (a privacy id with no known phone number) the file is kept and flagged **needs review**; staff attach
  it to the right customer of that business from *Files to review*.
* **Notes & follow-ups**: internal notes with author and time, optional follow-up date, optionally tied to one of the customer's requests;
  mark done. Never shown to customers.

## 4. Customer Reports (dashboard → Customer Reports)

A date range plus the selected business. Every tile is defined (hover, and "How each figure is defined" on the page — also returned by the
API) and opens the customers behind it in the directory below. Metrics: total / new / active customers, customers with requests, quotation and
appointment requests, quotation requests by status, quotations delivered, approved-not-yet-sent, open requests, carts submitted / open /
idle 7+ days, documents received / sent, files to review, follow-ups outstanding / overdue.

**Exports** (`GET /api/dashboard/customer-reports/export?dataset=customers|quotations|summary&format=csv|xlsx|pdf&lang=en|ar` plus the same
filters as the screen) are built from the same queries as the directory and the tiles, for the business the staff member selected (no account
id is read from the request), under the `customers` view permission, up to 5,000 rows (the real count is stated when the file is limited):

* **CSV** — UTF-8 with BOM so Excel reads Arabic; spreadsheet formulas in customer text are neutralised. Unchanged from before.
* **Excel (.xlsx)** — written by src/customers/xlsx.ts, a small dependency-free writer (no spreadsheet or zip library is installed or needed).
  Sheet 1 is the table (bold frozen header, filter, widths; right-to-left in Arabic with Arabic headers and statuses); sheet 2 states the business,
  the report, the date range, **every active filter**, the record count and when it was generated (business timezone). Text is stored as text,
  never as a formula, so a customer name such as `=HYPERLINK(...)` is inert; XML-illegal characters are removed; cells are capped at Excel's limit.
  Read back with an independent reader (openpyxl) during development.
* **PDF** — a complete, script-free **print report** (A4 landscape, repeating table header, right-to-left for Arabic) built from the same
  dataset and the same context block; the button opens the browser's print dialog, where *Save as PDF* keeps a file. No PDF library was added on
  purpose: Arabic needs real shaping and right-to-left layout (the browser's print engine does it correctly; a small PDF library does not), the
  alternatives are a headless browser (not available on this server) or bundling fonts and a layout engine, and the print view already exists
  everywhere staff work. The response is served under default-src 'none'.

## 5. Permissions

Enforced on the server for every API call (`src/dashboard/authorize.ts`; the sidebar mirrors it in `dashboard/shell.js`, tested together).

| Needs | Routes |
| --- | --- |
| `customers` view | directory, profile, timeline, documents, file open/download, notes list, reports summary, CSV / Excel / print-PDF export, files-to-review |
| `customers` edit | profile edit, add note, mark follow-up done, attach a file to a customer, read / re-read the text of a PDF |
| `requests` view | read the quotation workspace of a request |
| `requests` edit | save draft, finalise, approve, reject, send, mark sent, attach a quotation document, change status |

Preset roles follow the existing model (Admin/Manager: everything; User: view only; Custom: as granted); users only see their assigned
businesses; the permanent Super Admin is untouched by any of this.

## 6. Data and migration

`021_customer_history_inquiry_cart_quotations.sql` is **additive only**: new nullable/defaulted columns (`customers.email/company_name`,
`customer_requests.cart_id/source`, `request_events.admin_user_id/reason`, `notification_outbox.attachment_file_id`) and new tables
(`inquiry_carts`, `inquiry_cart_items`, `customer_files`, `quotation_versions`, `quotation_lines`, `customer_notes`) with indexes and the
uniqueness rules above. Existing rows are untouched (tested: `tests/unit/memory/migration021.test.ts`). Nothing is deleted or rewritten, and
historical requests keep `source = 'menu'`.

`022_customer_file_text_extraction.sql` is also additive: four columns on `customer_files` (`extracted_at`, `extraction_error`, `extraction_pages`,
`extraction_attempts` default 0). Existing rows are untouched (tested: `tests/unit/memory/migration022.test.ts`).

## 7. What was tested, and what only a live WhatsApp session can show

Automated (simulated provider, disposable databases): cart flow in both languages and both menu shapes, quotation lifecycle and delivery
outcomes, outbox idempotency, permissions and cross-business isolation, file capture limits and downloads, timeline, reports, CSV / Excel / print-PDF
exports (filters, isolation, permissions, injection), automatic expiry with controlled dates and timezones, PDF text extraction with real PDFs,
migrations 021 and 022.
**Not provable offline**: that WhatsApp really delivers the quotation document/image to a phone, and that Baileys can download a customer's
media on the live connection — verify once by sending a PDF to a live number and by sending a quotation to a test customer.
