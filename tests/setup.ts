// Loaded before every test file (see vitest.config.ts setupFiles). Provides
// safe fake values for every required env var so env.ts validation passes
// without any real third-party credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';

// The network is stubbed in tests, so OpenRouter's public catalog is never read and no model has a known price; strict free-only routing
// (the production default) would then skip every route. Tests that exercise the client opt in here to "unknown price = allowed"; the
// tests of the fail-closed rule switch it off explicitly. Imported lazily so the env below is in place before src modules load.
beforeAll(async () => {
  const router = await import('../src/llm/aiRouter');
  const catalog = await import('../src/llm/modelCatalog');
  router.allowUnknownPriceForTests(true);
  catalog.disableCatalogFetchForTests(true); // scripted fetch answers must never be consumed by a catalog download
});
// Route / provider cooldowns are process-wide: a failure scripted by one test must not silence the route in the next one.
beforeEach(async () => {
  const router = await import('../src/llm/aiRouter');
  router.resetAiRouterForTests();
});

// Tests supply their own environment. Never reload production secrets from .env.
vi.mock('dotenv', () => ({ config: vi.fn() }));
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '3999';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.DATABASE_PATH = ':memory:';
// Per-business knowledge/uploads of a test run live in a throw-away folder, never next to the real data.
// One folder per test file (the database is per test file too), so a file never meets another file's leftovers.
const accountsKnowledgeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-ai-agent-test-knowledge-'));
process.env.KNOWLEDGE_ACCOUNTS_DIR = accountsKnowledgeDir;
// The legacy business's knowledge/ is likewise a throw-away copy of the repository files: tests that edit and restore faq.md or
// booking.json must never touch the real files (on the production server `npm test` runs next to the live knowledge folder).
const legacyKnowledgeCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-ai-agent-test-legacy-knowledge-'));
const repoKnowledge = path.join(__dirname, '..', 'knowledge');
for (const entry of fs.readdirSync(repoKnowledge, { withFileTypes: true })) {
  if (entry.isFile() && /\.(md|json)$/.test(entry.name)) fs.copyFileSync(path.join(repoKnowledge, entry.name), path.join(legacyKnowledgeCopy, entry.name));
}
process.env.KNOWLEDGE_LEGACY_DIR = legacyKnowledgeCopy;
afterAll(() => {
  fs.rmSync(legacyKnowledgeCopy, { recursive: true, force: true });
  fs.rmSync(accountsKnowledgeDir, { recursive: true, force: true });
});

process.env.WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN ?? 'test-whatsapp-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '1234567890';
process.env.WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN ?? 'test-verify-token';
process.env.META_APP_SECRET = process.env.META_APP_SECRET ?? 'test-app-secret';
process.env.WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION ?? 'v21.0';

process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? 'test-openrouter-key';
process.env.OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';

process.env.GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL ?? 'test@example.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY =
  process.env.GOOGLE_PRIVATE_KEY ??
  '-----BEGIN PRIVATE KEY-----\\nFAKEKEYFORTESTSONLY\\n-----END PRIVATE KEY-----\\n';
process.env.GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? 'primary';

process.env.BUSINESS_NAME = process.env.BUSINESS_NAME ?? 'Test Business';
process.env.BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE ?? 'UTC';
// Open all day: the suite must not depend on the wall clock (at 09:00-18:00 UTC it passed, after 18:00 UTC the after-hours menu answered instead).
process.env.BUSINESS_HOURS_START = process.env.BUSINESS_HOURS_START ?? '00:00';
process.env.BUSINESS_HOURS_END = process.env.BUSINESS_HOURS_END ?? '23:59';
process.env.BUSINESS_DAYS = process.env.BUSINESS_DAYS ?? '1,2,3,4,5,6,7';

process.env.RESTART_KEYWORDS = process.env.RESTART_KEYWORDS ?? 'restart,reset,start over';
process.env.CONVERSATION_HISTORY_LIMIT = process.env.CONVERSATION_HISTORY_LIMIT ?? '20';
process.env.MAX_TOOL_ROUNDS = process.env.MAX_TOOL_ROUNDS ?? '4';

// A fixed, obviously-fake 32-byte key (base64) — required unconditionally by
// env.ts for the dashboard's encrypted secret store, even in tests.
process.env.DASHBOARD_MASTER_KEY =
  process.env.DASHBOARD_MASTER_KEY ?? 'DZLe+BvfUId17vxA3cwqtF4GC0L+Zeh3LkN+CEvlxng=';
