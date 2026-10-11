# Appearance (light / dark) and developer branding

## Two appearances, one set of tokens

* **Light** is the default and is unchanged. `<html data-theme="light">` ships in `dashboard/index.html`; nothing in the dark layer applies to it.
* **Dark** is a complete SYNRTECHS-branded appearance in one file, `dashboard/theme-dark.css`, loaded after `ui.css` and `login.css`. Every rule
  in it starts with `[data-theme="dark"]` (a test enforces this), so the light appearance cannot be affected. Components keep reading the shared tokens
  (`--color-surface`, `--color-text`, `--color-primary`, …); the dark layer re-points those tokens and re-skins the few components that used fixed colours
  (the gradient top bar, the coloured KPI and alert cards).
* The choice is remembered in this browser (`localStorage["workspace.theme"]`) and applied by `dashboard/theme-init.js`, which runs in `<head>` before any
  stylesheet, so there is no flash of the other appearance. With no saved choice the page is light (the operating system's dark mode is not followed).
* **Switches:** the top bar has one (`#theme-toggle`); the sign-in page has the same switch, mounted before anyone is signed in
  (`mountThemeSwitches()` in `shell.js`, slot `[data-theme-switch]`). Both are `role="switch"` buttons with `aria-checked`, an accessible name, keyboard
  support (Tab, Space/Enter) and a visible focus ring, and both work in English and Arabic (RTL mirrors the knob and the layout). Switching the
  appearance is a display change only: it makes no API call and touches no credential, session or setting. Changing language keeps the theme.

## The SYNRTECHS palette

Source: the supplied brand guide `Synrtechs_DESIGN 1.pdf`; nothing was invented.

| Item | Guide value | Use |
| --- | --- | --- |
| Navy | `#071740` | sign-in brand panel, company sidebar, sign-in button, deep surfaces |
| Teal | `#27E6C5` | the signal in the dark appearance: primary buttons (navy label, 11:1), focus ring, active/selected state, key figures |
| Purple | `#6941E2` | decorative shapes, the sign-in button's hover fill (white on it 6:1). It is 2.6:1 on navy, so it never carries text (`#B4A0F5` is its text tint) |
| Coral | `#FF6B6B` | danger and errors |
| Type | Space Mono, Cairo | Space Mono for the small spaced labels, Cairo for Arabic (both SIL Open Font Licence, shipped in `assets/fonts` with `Cairo-SpaceMono-OFL.txt`); Geist stays the Latin body face; Arial is the last fallback |

Not in the guide, so **derived from the navy, not invented** (and marked in the CSS header): canvas `#050E2D` (navy darkened), panel `#0B1C4A` and raised/hover
`#122760` (steps between canvas and line), hairline `#26396F`, input border `#6F83C0` (4.4:1+ on every panel), muted text `#AAB6DC` (7:1+), and the status
colours the guide does not define (success green `#6FD0A7`, warning amber `#F5B94A`).

Contrast is tested (`tests/unit/dashboard/theme.test.ts`): white, muted, teal and the violet text tint reach 4.5:1 on canvas, panel and the raised rows; the navy
label on teal reaches 4.5:1; input borders reach 3:1; status colours reach 4.5:1; every text colour on the sign-in navy panel reaches 4.5:1.

## Arabic

Arabic uses `"Cairo", "Segoe UI", Tahoma, …` in both appearances (`rtl.css`, and `--font-sans` in the dark layer). Cairo is self-hosted (arabic and latin subsets of the
variable font). Letter-spacing is removed for Arabic labels (it breaks joins), the small mono labels switch to Cairo (Space Mono has no Arabic glyphs), the logo
image is never mirrored while the decorative shapes beside it are.

## The sign-in page

The brand panel is the guide's navy with a violet light from one corner and a teal one from the other, three sheared slabs on the 30° angle of the S mark
(a quiet echo of the logo, drawn in `app.js`, never a copy), the white SYNRTECHS lockup, and the product line. It is the same in both appearances; the form side is
the light canvas or the deep navy canvas. On tablets the panel becomes a banner; on phones it is hidden and the card carries the colour/white lockup.
**No customer logo appears on the sign-in page, the tab icon or the app icon**: the favicon and `logo-192.png` are the guide's navy S tile.

## Whose interface is it? (SYNRTECHS vs company branding)

Decided on the **server**, from the signed-in user's real account assignments (`src/dashboard/branding.ts`, returned as `branding` by `GET /api/dashboard/me`):

| Who signs in | Interface identity |
| --- | --- |
| Super Admin, or a user granted "all accounts" | SYNRTECHS (the official logo) |
| A user with exactly **one** assigned, existing, enabled WhatsApp account | That company: its name (Arabic name in the Arabic interface), its logo, a company-branded sidebar and header in the design language of the sign-in page, no account switcher, no other business visible, and "Developed by" + the SYNRTECHS logo in the footer |
| A user with several accounts, **or none**, or anything unclear (account missing or disabled, access revoked, disabled user) | SYNRTECHS; with no account at all the dashboard calls are refused (fail closed) |

* The only input is the authenticated user. The browser's storage, the URL, headers and any company id are never used (tests send forged headers, query parameters and
  a stale stored account id; branding and data stay the user's own). The page re-reads `/me` whenever the set of accounts the user may open changes, so granting or revoking
  access updates branding and permissions without a stale company.
* Permissions are untouched: branding is display only (a company-branded "user" is still view-only).

### Where each company's logo comes from
`business_settings.logo_document_id` is the account's own verified logo document (active image, PNG/JPEG/WebP, up to 2 MB, present on disk). It is looked up **scoped to the account that
owns the setting** (a document id belonging to another business is "not found") and served only to that company's own signed-in user at `GET /api/dashboard/branding/logo`
(takes no id; `private` cache, `nosniff`, sandbox CSP). Fallbacks, never another company's logo: the bundled `logo.webp` for the original business (account 1) when it has no logo
document, otherwise a neutral initial tile.

| Account | Name shown | Logo used |
| --- | --- | --- |
| 1 | Rowad Alfa Auto Care / شركة رواد ألفا للعناية بالسيارات | the bundled `dashboard/assets/logo.webp` (no logo document; served as public application artwork) |
| 2 | JOTUN Rowad Alfa / جوتن رواد الفا | **the same Rowad Alfa logo**: the owner confirmed both businesses sit under the same parent company, so account 2's logo document is its own stored copy of `logo.webp` (in `accounts/2/uploads`, byte-identical to the bundled file) |
| 3 | QMULATE Real Estate Consultancy / QMULATE للاستشارات العقارية | its own stored `logo.png` (document 6, in `accounts/3/uploads`) |

Sharing one logo merges nothing: each business keeps its own account id, WhatsApp session, conversations, knowledge, customers, permissions and settings, and
each can read only its own logo route (tests: `tests/integration/branding.e2e.test.ts`, "share the same company logo"). A missing, archived, oversized or unreadable logo falls back to the
initial tile; a logo that fails to load in the browser is replaced by the tile.

## Developer branding

* The developer is shown as **SYNRTECHS**. The artwork is taken **as drawn from the supplied brand guide** (`Synrtechs_DESIGN 1.pdf`): the lockup (S mark + lettering) is vector
  paths in the PDF, extracted unchanged into `dashboard/assets/developer/` as `synrtechs-logo.svg` (navy + purple mark, black lettering: light surfaces),
  `synrtechs-logo-white.svg` (the guide's white variant: dark surfaces), and `synrtechs-mark.svg` / `synrtechs-mark-white.svg` (the S mark alone, used in the top bar). They are
  never retyped, recoloured, stretched or approximated. The favicon and app icon are the guide's navy rounded S tile rendered from the same PDF.
* The supplied `original_logo_wide_transparent.png` contains only the S mark (the canvas is 3148×744 but nothing is drawn right of the mark), so it cannot serve as the
  wide lockup; `original_logo_icon_transparent.png` is the same mark as `synrtechs-mark.svg`. `Synrtechs_STS_Stamp.png` is the company's commercial-registration stamp
  and is deliberately **not** used in the interface.
* Locations: the sign-in page, the sidebar of developer-mode users, the top-bar mark, the footer next to a company's workspace ("Developed by" + logo), and a row on the System page.
* No tagline, address, phone number or other company detail was added: only the name and logo the guide approves.
