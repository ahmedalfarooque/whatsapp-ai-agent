# Appearance (light / dark) and developer branding

## Two appearances, one set of tokens

* **Light** is the default and is unchanged. `<html data-theme="light">` ships in `dashboard/index.html`; nothing in the dark layer applies to it.
* **Dark** is a complete SynrTech Studio–branded appearance in one file, `dashboard/theme-dark.css`, loaded after `ui.css` and `login.css`. Every rule
  in it starts with `[data-theme="dark"]` (a test enforces this), so the light appearance cannot be affected. Components keep reading the shared tokens
  (`--color-surface`, `--color-text`, `--color-primary`, …); the dark layer re-points those tokens and re-skins the few components that used fixed colours
  (the gradient top bar, the coloured KPI and alert cards, the sign-in brand panel).
* The choice is remembered in this browser (`localStorage["workspace.theme"]`) and applied by `dashboard/theme-init.js`, which runs in `<head>` before any
  stylesheet, so there is no flash of the other appearance. With no saved choice the page is light (the operating system's dark mode is not followed).
* **Switches:** the top bar has one (`#theme-toggle`); the sign-in page has the same switch, mounted before anyone is signed in
  (`mountThemeSwitches()` in `shell.js`, slot `[data-theme-switch]`). Both are `role="switch"` buttons with `aria-checked`, an accessible name, keyboard
  support (Tab, Space/Enter) and a visible focus ring, and both work in English and Arabic (RTL mirrors the knob and the layout). Switching the
  appearance is a display change only: it makes no API call and touches no credential, session or setting.

## What the dark appearance takes from the brand kit

Source: the supplied SynrTech Studio brand kit (`brand-tokens.json` v2.1, the colour and typography references, the web stylesheet, the approved logo
files), read from the supplied files; nothing was invented.

| Item | Brand rule applied |
| --- | --- |
| Canvas | Warm Charcoal `#111112` |
| Panels, cards, sidebar | Graphite `#222222` (never used for text) |
| Body text | White `#FFFFFF`, full strength |
| Titles and key figures | Peach Copper `#D7A17F` |
| Secondary text (sources, dates, units) | Tertiary grey `#A1A3A4` |
| Primary buttons, focus, active/selected marks | Fantasy Teal `#20AFBD`, button labels in charcoal (7.1:1) |
| Hairlines | `#363637` |
| Links and navigation | Neutral white (the brand keeps these neutral) |
| Latin type | Geist (open-licence font, shipped in `dashboard/assets/fonts`), Geist Mono for small labels; Arial is the single fallback |
| Sign-in brand panel | The approved *sculpted contours* pattern, on charcoal only |

Not in the kit, so **derived, not invented** (and marked in the CSS): the state layer between graphite and the hairline (`#2C2C2D`, hover rows), the input
border (`#717273`, an interpolation that reaches 3:1 on graphite), and the functional status colours (success green, danger red; warning uses Peach Copper
and info uses Teal). The kit defines no UI feedback colours, so these need the brand owner's decision if they want different ones.

Contrast is tested (`tests/unit/dashboard/theme.test.ts`): white, copper and tertiary text reach 4.5:1 on charcoal, graphite and the raised rows; the
charcoal button label on teal reaches 4.5:1; teal focus and input borders reach 3:1; the status colours reach 4.5:1 on both panels.

## Arabic in the dark appearance

Arabic uses `"Thmanyah Sans", "Geist", Arial, …`. **The Thmanyah files are not shipped:** their licence limits public hosting of the font files, and this
application is on a public address. Thmanyah Sans is used only when it is installed on the viewer's device; otherwise Arial/Segoe UI/Tahoma render the
Arabic. Letter-spacing is removed for Arabic labels (brand rule). To get Thmanyah everywhere, the brand owner must confirm that self-hosting on this
domain is permitted, then the woff2 files can be added to `dashboard/assets/fonts` and declared in `theme-dark.css`.

## Whose interface is it? (SynrTech Studio vs company branding)

Decided on the **server**, from the signed-in user's real account assignments (`src/dashboard/branding.ts`, returned as `branding` by `GET /api/dashboard/me`):

| Who signs in | Interface identity |
| --- | --- |
| Super Admin, or a user granted "all accounts" | SynrTech Studio (the official wordmark) |
| A user with exactly **one** assigned, existing, enabled WhatsApp account | That company: its name (Arabic name in the Arabic interface), its logo, a company-branded sidebar and header in the design language of the sign-in page, no account switcher, no other business visible, and "Developed by SynrTech Studio" in the footer |
| A user with several accounts, **or none**, or anything unclear (account missing or disabled, access revoked, disabled user) | SynrTech Studio; with no account at all the dashboard calls are refused (fail closed) |

* The only input is the authenticated user. The browser's storage, the URL, headers and any company id are never used (tests send forged headers, query parameters and
  a stale stored account id; branding and data stay the user's own). The page re-reads `/me` whenever the set of accounts the user may open changes, so granting or revoking
  access updates branding and permissions without a stale company.
* The sign-in page is shown before anyone is known, so it carries SynrTech Studio's identity (wordmark), not a customer's.
* Permissions are untouched: branding is display only (a company-branded "user" is still view-only).

### Where each company's logo comes from
`business_settings.logo_document_id` is the account's own verified logo document (active image, PNG/JPEG/WebP, up to 2 MB, present on disk). It is looked up **scoped to the account that
owns the setting** (a document id belonging to another business is "not found") and served only to that company's own signed-in user at `GET /api/dashboard/branding/logo`
(takes no id; `private` cache, `nosniff`, sandbox CSP). Fallbacks, never another company's logo:

| Account (production, verified from the records) | Logo used |
| --- | --- |
| 1 · Rowad Alfa Auto Care / شركة رواد ألفا للعناية بالسيارات | the bundled `dashboard/assets/logo.webp` (the original business's artwork already shipped with the application) |
| 2 · JOTUN Rowad Alfa / جوتن رواد الفا | **none exists in the project or the records** → a neutral initial tile (J). Upload the verified JOTUN logo as the account's logo document to replace it |
| 3 · QMULATE Real Estate Consultancy / QMULATE للاستشارات العقارية | its stored logo document (PNG) |

A missing, archived, oversized or unreadable logo falls back to the initial tile; a logo that fails to load in the browser is replaced by the tile.
## Developer branding

* The developer is shown as **SynrTech Studio**, the spelling in the brand rules ("capital T"; the legal name SynerTechs Company is reserved for legal
  footers, contracts and invoices, so it is not used in the interface). The wordmark is the supplied artwork, black on light and white on dark
  (`dashboard/assets/developer/`), never retyped; no monogram or icon is used because none is approved.
* Locations: the sign-in page identity itself, the sidebar of developer-mode users, the footer next to a company's workspace ("Developed by" + wordmark), and a row on the System page. The businesses
  served (Rowad Alfa, JOTUN Rowad Alfa, QMULATE) keep their own names, logos and content; the developer credit is separate and small.
* No tagline, address, phone number or other company detail was added: only the name and logo that the brand kit approves for this use. A website link
  was not added because no public page for the developer is documented in the supplied material.
