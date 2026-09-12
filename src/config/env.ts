import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const csvList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * Credentials required for real external integrations. These are OPTIONAL
 * at the schema level (so development can start without them) but are
 * enforced as mandatory by the `.superRefine` below whenever
 * NODE_ENV=production. They must never be required in development/test —
 * that's what lets `npm run dev` start with mock providers (see
 * src/whatsapp/client.ts, src/llm/openRouterClient.ts,
 * src/calendar/availability.ts / booking.ts) and no real credentials.
 */
const PRODUCTION_REQUIRED_KEYS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'META_APP_SECRET',
  'OPENROUTER_API_KEY',
  'GOOGLE_CLIENT_EMAIL',
  'GOOGLE_PRIVATE_KEY',
] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_PATH: z.string().default('./data/app.db'),

    // Optional at the schema level — see PRODUCTION_REQUIRED_KEYS above.
    WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
    WHATSAPP_VERIFY_TOKEN: z.string().optional().default(''),
    META_APP_SECRET: z.string().optional().default(''),
    WHATSAPP_API_VERSION: z.string().default('v21.0'),

    OPENROUTER_API_KEY: z.string().optional().default(''),
    OPENROUTER_MODEL: z.string().default('openai/gpt-4o-mini'),
    OPENROUTER_SITE_URL: z.string().optional().default(''),
    OPENROUTER_APP_NAME: z.string().optional().default('WhatsApp AI Agent'),

    GOOGLE_CLIENT_EMAIL: z.string().optional().default(''),
    GOOGLE_PRIVATE_KEY: z.string().optional().default(''),
    GOOGLE_CALENDAR_ID: z.string().default('primary'),
    GOOGLE_PROJECT_ID: z.string().optional().default(''),

    BUSINESS_NAME: z.string().default('The Business'),
    BUSINESS_TIMEZONE: z.string().default('UTC'),
    BUSINESS_PHONE: z.string().optional().default(''),
    BUSINESS_EMAIL: z.string().optional().default(''),
    BUSINESS_HOURS_START: z.string().default('09:00'),
    BUSINESS_HOURS_END: z.string().default('18:00'),
    BUSINESS_DAYS: z.string().default('1,2,3,4,5,6'),

    BOOKING_DURATION_MINUTES: z.coerce.number().int().positive().default(30),
    BOOKING_BUFFER_MINUTES: z.coerce.number().int().nonnegative().default(0),

    RESTART_KEYWORDS: z.string().default('restart,reset,start over'),
    CONVERSATION_HISTORY_LIMIT: z.coerce.number().int().positive().default(20),
    MAX_TOOL_ROUNDS: z.coerce.number().int().positive().default(4),
    OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    WHATSAPP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    GOOGLE_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

    MAX_BODY_SIZE: z.string().default('1mb'),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),

    // Encrypts the dashboard's server-side credential-override store
    // (src/config/secretStore.ts). Required in EVERY environment — unlike
    // the WhatsApp/OpenRouter/Google keys, dashboard auth/secret storage is
    // not an optional mock-in-dev feature, so this is validated below
    // unconditionally, not gated on NODE_ENV=production.
    DASHBOARD_MASTER_KEY: z.string().optional().default(''),
  })
  .superRefine((data, ctx) => {
    // The master key must always be present and decode to exactly 32
    // bytes (base64 or hex), in every environment. This is intentionally
    // NOT gated on NODE_ENV — a missing/invalid key must fail closed
    // everywhere, never silently disable auth or fall back to plaintext.
    const keyBuffer = decodeMasterKeyForValidation(data.DASHBOARD_MASTER_KEY);
    if (!keyBuffer || keyBuffer.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DASHBOARD_MASTER_KEY'],
        message:
          'DASHBOARD_MASTER_KEY is required and must decode (base64 or hex) to exactly 32 bytes. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      });
    }

    // Real credentials are mandatory ONLY in production. Development and
    // test never require them — this is what makes `npm run dev` safe to
    // start without Meta/OpenRouter/Google credentials, and is also why
    // this check must never be loosened to cover 'production' accidentally
    // matching via string coercion or a typo — it's an exact enum compare.
    if (data.NODE_ENV !== 'production') return;

    for (const key of PRODUCTION_REQUIRED_KEYS) {
      if (!data[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when NODE_ENV=production`,
        });
      }
    }
  });

function decodeMasterKeyForValidation(value: string): Buffer | null {
  if (!value) return null;
  try {
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length === 32) return decoded;
    }
    if (/^[0-9a-fA-F]+$/.test(value)) {
      const decoded = Buffer.from(value, 'hex');
      if (decoded.length === 32) return decoded;
    }
    return null;
  } catch {
    return null;
  }
}

export type RawEnv = z.infer<typeof envSchema>;

function parseEnv(source: NodeJS.ProcessEnv): RawEnv {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    throw new Error('Invalid environment configuration. See stderr for details.');
  }
  return result.data;
}

const raw = parseEnv(process.env);

export const env = {
  ...raw,
  RESTART_KEYWORDS: csvList(raw.RESTART_KEYWORDS).map((s) => s.toLowerCase()),
  BUSINESS_DAYS: csvList(raw.BUSINESS_DAYS).map((s) => Number.parseInt(s, 10)),
  // googleapis expects real newlines in the PEM key, but .env files commonly
  // store it with literal \n escape sequences.
  GOOGLE_PRIVATE_KEY: raw.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
  /**
   * true for every mode except 'production'. Real integration clients
   * (WhatsApp, OpenRouter, Google Calendar) check this flag and delegate to
   * their mock implementation instead of making a real network call —
   * see src/whatsapp/client.ts, src/llm/openRouterClient.ts,
   * src/calendar/availability.ts, src/calendar/booking.ts.
   * There is deliberately no way to opt back into real providers from
   * development/test short of setting NODE_ENV=production, which in turn
   * requires all real credentials to be present (enforced above).
   */
  shouldUseMockProviders: raw.NODE_ENV !== 'production',
};

export type Env = typeof env;
