// Loaded before every test file (see vitest.config.ts setupFiles). Provides
// safe fake values for every required env var so env.ts validation passes
// without any real third-party credentials.
import { vi } from 'vitest';

// Tests supply their own environment. Never reload production secrets from .env.
vi.mock('dotenv', () => ({ config: vi.fn() }));
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '3999';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
process.env.DATABASE_PATH = ':memory:';

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
process.env.BUSINESS_HOURS_START = process.env.BUSINESS_HOURS_START ?? '09:00';
process.env.BUSINESS_HOURS_END = process.env.BUSINESS_HOURS_END ?? '18:00';
process.env.BUSINESS_DAYS = process.env.BUSINESS_DAYS ?? '1,2,3,4,5,6,7';

process.env.RESTART_KEYWORDS = process.env.RESTART_KEYWORDS ?? 'restart,reset,start over';
process.env.CONVERSATION_HISTORY_LIMIT = process.env.CONVERSATION_HISTORY_LIMIT ?? '20';
process.env.MAX_TOOL_ROUNDS = process.env.MAX_TOOL_ROUNDS ?? '4';

// A fixed, obviously-fake 32-byte key (base64) — required unconditionally by
// env.ts for the dashboard's encrypted secret store, even in tests.
process.env.DASHBOARD_MASTER_KEY =
  process.env.DASHBOARD_MASTER_KEY ?? 'DZLe+BvfUId17vxA3cwqtF4GC0L+Zeh3LkN+CEvlxng=';
