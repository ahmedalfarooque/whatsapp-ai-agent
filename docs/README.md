# Documentation Book — Source & Regeneration

`WhatsApp_AI_Agent_Complete_Project_Documentation.pdf` (52 pages) is generated
from `assets/documentation-source.html` — a single self-contained HTML file
(inline CSS, no external assets) written to describe the actual codebase as
of git commit `647193d`.

## Regenerating the PDF

Requires Node.js and a locally installed Chrome or Edge browser (used
headless, via `puppeteer-core` — no bundled Chromium download).

```bash
cd docs/assets
npm init -y
npm install puppeteer-core
node render-to-pdf.js documentation-source.html output.pdf
```

`render-to-pdf.js` looks for Chrome/Edge at their standard Windows install
paths; edit the `CHROME_PATHS` array at the top of the script if your
browser is installed elsewhere or you're on macOS/Linux.

## Editing the content

`documentation-source.html` is one long HTML file with a lightweight design
system (CSS classes: `.box.kid` / `.box.dev` / `.box.warn` / `.box.ok` /
`.box.plan` for callouts, `.flow`/`.flow-row` for diagrams, standard `<table>`
for data tables). Each chapter is a `<div class="chapter" id="chN">`.

The table of contents page numbers are **not** automatic — they were filled
in by rendering once, locating each chapter's real starting page with
`pymupdf`, then patching the `data-toc="chN"` spans and re-rendering. If you
edit the content in a way that changes page counts, re-run that two-pass
process (reset the spans, re-render, re-locate, re-patch, render again)
rather than hand-editing the numbers.
