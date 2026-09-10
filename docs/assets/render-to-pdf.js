const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

async function main() {
  const [, , htmlPath, pdfPath] = process.argv;
  if (!htmlPath || !pdfPath) {
    console.error('Usage: node render.js <input.html> <output.pdf>');
    process.exit(1);
  }

  const fs = require('fs');
  const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge binary found');

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.goto('file:///' + path.resolve(htmlPath).replace(/\\/g, '/'), {
    waitUntil: 'networkidle0',
  });

  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `
      <div style="width:100%; font-size:8px; color:#94a3b8; padding:0 18mm; font-family: Arial, sans-serif; display:flex; justify-content:space-between;">
        <span>WhatsApp AI Agent — Complete Project Documentation</span>
        <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
      </div>`,
    margin: { top: '10mm', bottom: '12mm', left: '14mm', right: '14mm' },
    preferCSSPageSize: false,
  });

  await browser.close();
  console.log('PDF written to', pdfPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
