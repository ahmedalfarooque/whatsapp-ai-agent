# Appearance (light / dark) and developer branding

## Two appearances, one set of tokens

The whole interface is drawn from **one token file, `dashboard/tokens.css`**. It holds the brand reference colours, the type, radius and motion scales, both appearances
(`:root,:root[data-theme="light"]` and `:root[data-theme="dark"]`), the legacy aliases the older scripts still name, the base type and focus rules, and the glass rules. Nothing
else defines a colour per theme: `ui.css`, `login.css` and `company.css` only read tokens (a test fails if a component stylesheet branches on the appearance, except a short
documented list of swaps such as the logo lockup), and the former parallel `theme-dark.css` no longer exists.

* **Light** is the default (`<html data-theme="light">`): a cool slate canvas (#EEF0F5) with white cards and a white header and sidebar, so every panel is outlined by a hairline (#D9DEE9) and a small crisp contact shadow (white-on-grey is what keeps light themes readable), navy ink. Teal fills the
  primary action (navy label), purple marks the secondary emphasis (selected navigation, the sign-in hover) and the focus ring, coral is danger.
* **Dark** is an ink-charcoal with a faint blue cast, stepped by lightness: canvas `#0A0D14` < sidebar `#0E121B` < card `#141925` < raised `#1B2131` < hover/selected `#242C40`. Cards are\n  separated by that step and a low-contrast hairline, never by a glowing outline. Text is an off-white (`#ECEFF7`) with three quieter steps; brand navy lives in the logo tile and the sign-in panel,\n  teal appears only for the primary action, the live state and links, and purple tints the selection.
* **Semantic tokens** per appearance: surfaces, borders, text (4 steps), primary/accent/secondary, success/warning/danger/info each as text colour, soft tint and hairline, depth
  (`--elev-1/2`, `--shadow-overlay`), the scrim, glass, the canvas wash and the chart series. Contrast of every text, tone-on-tint, button label, control edge and focus ring pair is tested
  for both appearances (`tests/unit/dashboard/theme.test.ts`: 4.5:1 for text, 3:1 for control edges and the focus ring).
* **Glass is selective.** Translucency (a bounded blur of 14 / 22 px) is used only for the header, the profile menu, toasts, dialog scrims and the sign-in card, and the four promise tiles
  of the sign-in brand panel. Each has a near-opaque base colour, every `backdrop-filter` sits inside `@supports`, and `prefers-reduced-transparency` switches it off. The sidebar and
  ordinary cards are solid.
* **Motion** is short and only where it helps (hover lift, switch, the sign-in card rising); `prefers-reduced-motion` removes it.
* The choice is remembered in this browser (`localStorage["workspace.theme"]`) and applied by `dashboard/theme-init.js`, which runs in `<head>` before any stylesheet, so there is no
  flash of the other appearance. With no saved choice the page is light (the operating system's dark mode is not followed).
* **Switches:** the top bar has one (`#theme-toggle`); the sign-in page has the same switch, mounted before anyone is signed in (`mountThemeSwitches()` in `shell.js`, slot
  `[data-theme-switch]`). Both are `role="switch"` buttons with `aria-checked`, an accessible name, keyboard support (Tab, Space/Enter) and a visible focus ring, and both work in
  English and Arabic (RTL mirrors the knob and the layout). Switching the appearance is a display change only: it makes no API call and touches no credential, session or setting.

### Shell and components

* **Header** (`.topbar`): a sticky bar spanning the work area, bounded by one hairline: the account logo, the page title with the account line under it (name, masked number, status), and 34 px controls
  (language, AI state, theme, date range, user menu, settings) on the right. The page description stays in the document for assistive technology but is not drawn. Teal marks only the state that is on.
  On phones the header sits in the page flow, the theme and account labels become screen-reader-only, and the controls take two rows.
* **Sidebar**: one surface step above the canvas, semibold group labels in the body face, line icons (never emoji), a purple-tinted selected item (no side rail), and account rows with their own
  logo, masked number and status dot; the selected account is lifted. Long business names wrap to two lines instead of ending in an ellipsis.
* **Home**: one attention bar (connections, requests, AI and automation as three cells with a tone dot and a View action, stacked below 1240 px), one KPI strip (five cells, hairline dividers, no icon chips), then two
  columns: the work (recent conversations, customer requests) on the left and the machine (activity with period tabs, AI and automation) on the right. Figures are plain and divided, not tinted tiles; the decorative mascot is gone.
* **Conversations**: one bordered workspace split by a hairline (list | thread) that fills the viewport height; the thread has its own header (avatar, name, state, actions), day separators, bubbles by sender (customer, AI, automatic reply, staff) and a composer pinned to the bottom. Below 900 px it is list-then-thread with a back button.
* **Shared**: panels, tables (sticky header, hairline rows), buttons (primary teal, tonal success/danger, ghost), fields, switches, tabs, badges and chips (tone tint + hairline), toasts
  (tone rail), dialogs (surface + scrim with a small blur), scrollbars — all token-driven, in both appearances and in RTL.

## The SYNRTECHS palette

Source: the supplied brand guide `Synrtechs_DESIGN 1.pdf`; nothing was invented. These are **reference** colours, not a paint box.

| Item | Guide value | Use |
| --- | --- | --- |
| Navy | `#071740` | sign-in brand panel, company sidebar, the light sign-in button, the logo tile, deep surfaces |
| Teal | `#27E6C5` | primary action fill (navy label, 11:1), focus ring and accent in dark, selected-state rail, live indicators |
| Purple | `#6941E2` | secondary emphasis: selected navigation tint, focus ring in light, the sign-in button's hover fill (white on it 6:1). Its text tint is `#B8A6F7` in dark and `#5A33D0` in light |
| Coral | `#FF6B6B` | danger and errors |
| Type | Geist, Space Mono, Cairo | Geist for Latin body text in both appearances, Space Mono kept for the sign-in page labels, Cairo for Arabic (open licences, shipped in `assets/fonts` with `Geist-OFL.txt` and `Cairo-SpaceMono-OFL.txt`) |

Everything else (canvas, panels, hairlines, muted text, the text-safe teal `#08796E` for light, the semantic status colours) is **derived from the navy** and checked for contrast; the values are in
`tokens.css`.
## Arabic

Arabic uses `"Cairo", "Segoe UI", Tahoma, …` in both appearances (`rtl.css`, and `--font-sans` in the dark layer). Cairo is self-hosted (arabic and latin subsets of the
variable font). Letter-spacing is removed for Arabic labels (it breaks joins), the small mono labels switch to Cairo (Space Mono has no Arabic glyphs), the logo
image is never mirrored while the decorative shapes beside it are.

## The sign-in page

The brand panel is the guide's navy with a violet light from one corner and a teal one from the other, a fine grid that fades out, three sheared slabs on the 30° angle of the S mark
(a quiet echo of the logo, drawn in `app.js`, never a copy), the white SYNRTECHS lockup, the product line and four glass promise tiles. It is the same in both appearances; the form side is
the soft light canvas or the deep navy canvas with a single glass card (larger inputs, a navy primary button that turns violet on hover in light and a teal one in dark, clear focus and error states, password reveal, loading state). On tablets the panel becomes a banner; on phones it is hidden and the card carries the colour/white lockup.
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

### Selected-account identity (top bar, title line, account list)
Independently of the sidebar branding above, every page shows the identity of the **selected WhatsApp account**: its logo in the top bar, and above the page title its name
(Arabic name in the Arabic interface), the masked number (last four digits) and the connection status. The only source is the server's access-filtered accounts list
(`GET /api/dashboard/accounts` → `logoUrl`, `nameAr`, `uiStatus`), never the URL, a header or browser storage. `logoUrl` is `/api/dashboard/accounts/<id>/logo?v=<version>`; the route runs
the same account-access check as every account route, so a user who is not assigned the account gets 403 (and 404 when the account has no logo). Account 1 with no logo document
keeps the bundled artwork URL. The identity is redrawn on every account switch, status change and language change (`workspace:accounts`, `workspace:account-changed`,
`workspace:lang`), and a logo that fails to load becomes the neutral initial tile, so a stale or foreign logo cannot remain. Tests: `tests/integration/branding.e2e.test.ts`,
`tests/unit/dashboard/branding.test.ts`.

### The header on a phone
At 640 px and below the account name may wrap onto a second line and the masked number and connection status follow it (nothing is hidden or
ellipsised); at 480 px and below the header becomes: menu button, logo and identity on the first row, then the page title and its description (two
lines at most), then the controls (language, AI state, theme, user). A status chip wider than the screen wraps inside itself. This was measured in
a browser at 320, 360, 375, 390, 430, tablet and desktop widths, English and Arabic, light and dark, for a single-account and a multi-account user:
no element clipped, overlapping or outside the screen, and no horizontal page scroll. The one deliberate truncation left is the small detail line of
the AI pill on desktop (its full text is in the pill's tooltip). The rules are guarded by `tests/unit/dashboard/responsiveHeader.test.ts`.

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
