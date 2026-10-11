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

## Developer branding

* The developer is shown as **SynrTech Studio**, the spelling in the brand rules ("capital T"; the legal name SynerTechs Company is reserved for legal
  footers, contracts and invoices, so it is not used in the interface). The wordmark is the supplied artwork, black on light and white on dark
  (`dashboard/assets/developer/`), never retyped; no monogram or icon is used because none is approved.
* Locations: under the sign-in card ("Developed by" + wordmark), in the page footer of the application, and as a row on the System page. The businesses
  served (Rowad Alfa, JOTUN Rowad Alfa, QMULATE) keep their own names, logos and content; the developer credit is separate and small.
* No tagline, address, phone number or other company detail was added: only the name and logo that the brand kit approves for this use. A website link
  was not added because no public page for the developer is documented in the supplied material.
