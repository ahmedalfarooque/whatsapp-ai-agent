# Arabic / English dashboard interface

The sign-in page and the whole dashboard can be shown in **English** (left-to-right) or **العربية** (right-to-left). It is a display feature
only: switching never calls the API, never changes an account setting, a permission, a customer record, authentication or business
configuration, and never touches the language the WhatsApp assistant uses with customers (that is per customer and per business).

## How it works

* One shared mechanism, no per-screen conditionals: `dashboard/i18n.js` (engine) and `dashboard/i18n-ar*.js` (the Arabic dictionary, keyed by the
  exact English text, plus patterns for messages with numbers). The engine translates text nodes and the `placeholder`, `title`, `aria-label` and
  `alt` attributes, watches the page for anything drawn later (tables, dialogs, toasts, validation messages), and remembers the original English
  so switching back restores it exactly.
* The choice is stored in this browser only (`localStorage["workspace.lang"]`) and applied before the first paint (`dashboard/theme-init.js`), so
  it survives navigation and refresh and the sign-in page opens in the language last used.
* `<html lang dir>` flips with the language. `dashboard/rtl.css` holds the few corrections flex/grid mirroring cannot do (sidebar on the right,
  drawer from the right, toggle switches, list indents, separators, floating panels, Arabic type, arrows). English is untouched.
* Dates use the Gregorian calendar and numbers use Western digits in Arabic, matching quotations, references and phone numbers.
* New screens use the same system: write the English text and add its Arabic to the dictionary (`tests/unit/dashboard/i18n.test.ts` fails when a
  sidebar entry, a page title/description, a toast or a plain button has no Arabic, and when one English text has two different translations).
  Code that builds a message can call `t('English text', { name: value })`.

## What is deliberately not translated

Anything people or other systems wrote: customer names, company names, notes, message text, filenames and extracted document text, business
and product names, offers and replies the business wrote, WhatsApp numbers, e-mail addresses, URLs, reference ids (`INQ-…`), technical values
(ids, hashes, versions, model names). Emails, phone numbers, URLs and references are kept left-to-right inside Arabic text so digits and slashes
do not reorder. Message bodies, notes and previews are excluded from translation explicitly (`bubble-text`, `wa-msg`, `cu-notes`, `file`,
`translate="no"`), so a customer who happens to write a word that is also a label is never altered.

## Sign-in and security

The language switch on the sign-in page changes only text and direction. Credentials, the one-time-code step, session handling, redirects and
rate limits are the same in both languages, and the server's sign-in message stays generic (it never says whether an account exists).
