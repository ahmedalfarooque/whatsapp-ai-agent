#!/usr/bin/env node
/**
 * A DISPOSABLE preview of the built application for looking at dashboard changes in a browser: a throw-away SQLite database in the
 * system temp folder, mock providers (no WhatsApp socket, no OpenRouter call), no production data, no .env secrets. The first visit
 * creates the administrator through the dashboard's own setup flow. Nothing here touches data/, production or port 3005.
 *
 *   npm run build && node scripts/preview-disposable.cjs [--port 3400]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port') >= 0 ? Number.parseInt(argv[argv.indexOf('--port') + 1], 10) : 3400;
if (!Number.isInteger(portArg) || portArg < 1024 || portArg > 65535 || portArg === 3005) {
  console.error('--port must be 1024-65535 and never 3005 (another project)');
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
  console.error('dist/index.js is missing: run `npm run build` first');
  process.exit(2);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-ai-agent-preview-'));
process.env.NODE_ENV = 'development';
process.env.PORT = String(portArg);
process.env.DATABASE_PATH = path.join(tmp, 'preview.db');
process.env.KNOWLEDGE_ACCOUNTS_DIR = path.join(tmp, 'knowledge-accounts');
// A fresh random master key per preview run (the throw-away database never outlives the process, so nothing needs to be re-read later).
process.env.DASHBOARD_MASTER_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.OPENROUTER_API_KEY = 'preview-placeholder-key-not-real-0000000000';
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini';
process.env.WHATSAPP_CONNECTION_METHOD = 'qr';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
fs.mkdirSync(process.env.KNOWLEDGE_ACCOUNTS_DIR, { recursive: true });
console.log(`DISPOSABLE PREVIEW · database ${process.env.DATABASE_PATH} · http://localhost:${portArg}/dashboard/ · mock providers, no production data`);
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
require(path.join(root, 'dist', 'index.js'));
