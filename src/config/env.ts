import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const csvList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_PATH: z.string().default('./data/app.db'),

  WHATSAPP_ACCESS_TOKEN: z.string().min(1, 'WHATSAPP_ACCESS_TOKEN is required'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1, 'WHATSAPP_PHONE_NUMBER_ID is required'),
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required'),
  META_APP_SECRET: z.string().min(1, 'META_APP_SECRET is required'),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),

  OPENROUTER_API_KEY: z.string().min(1, 'OPENROUTER_API_KEY is required'),
  OPENROUTER_MODEL: z.string().default('openai/gpt-4o-mini'),
  OPENROUTER_SITE_URL: z.string().optional().default(''),
  OPENROUTER_APP_NAME: z.string().optional().default('WhatsApp AI Agent'),

  GOOGLE_CLIENT_EMAIL: z.string().min(1, 'GOOGLE_CLIENT_EMAIL is required'),
  GOOGLE_PRIVATE_KEY: z.string().min(1, 'GOOGLE_PRIVATE_KEY is required'),
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
});

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
  isTest: raw.NODE_ENV === 'test',
};

export type Env = typeof env;
