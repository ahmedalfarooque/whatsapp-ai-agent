import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const csvList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/**
 * The two optional WhatsApp transports. `qr` (default) is the Baileys /
 * WhatsApp Web QR connection, which needs no Meta credentials at all — the
 * scanned phone number becomes the agent number. `meta` is the Meta WhatsApp
 * Cloud API (webhook + Graph API), which needs the Meta credentials below.
 * The selected transport decides which credentials are mandatory in
 * production; NODE_ENV alone never does.
 */
export const WHATSAPP_CONNECTION_METHODS = ['qr', 'meta'] as const;
export type WhatsappConnectionMethod = (typeof WHATSAPP_CONNECTION_METHODS)[number];

/**
 * Meta WhatsApp Cloud API credentials. OPTIONAL at the schema level and
 * enforced as mandatory by the `.superRefine` below ONLY when
 * NODE_ENV=production AND WHATSAPP_CONNECTION_METHOD=meta. A production
 * deployment on the QR transport must start and run without any of them.
 */
export const META_CLOUD_API_REQUIRED_KEYS = [
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_VERIFY_TOKEN',
  'META_APP_SECRET',
] as const;

/**
 * Credentials required for the real AI provider regardless of the WhatsApp
 * transport. OPTIONAL at the schema level (so development can start without
 * them) but mandatory whenever NODE_ENV=production. They must never be
 * required in development/test — that's what lets the legacy local backend (`npm run legacy:isolated-backend`) start with
 * mock providers (see src/whatsapp/client.ts, src/llm/openRouterClient.ts,
 * src/calendar/availability.ts / booking.ts) and no real credentials.
 */
const PRODUCTION_REQUIRED_KEYS = ['OPENROUTER_API_KEY'] as const;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.string().default('info'),
    DATABASE_PATH: z.string().default('./data/app.db'),

    // Which WhatsApp transport this deployment uses. See
    // WHATSAPP_CONNECTION_METHODS above. Defaults to the QR transport; a
    // blank value (e.g. `WHATSAPP_CONNECTION_METHOD=` in .env) means default.
    WHATSAPP_CONNECTION_METHOD: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.enum(WHATSAPP_CONNECTION_METHODS).default('qr'),
    ),

    // Optional at the schema level — see META_CLOUD_API_REQUIRED_KEYS above.
    WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
    // Not required to send/receive messages (only the phone number ID is),
    // but used by the dashboard's Sync WhatsApp step to verify the
    // configured phone number actually belongs to this WABA.
    WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional().default(''),
    WHATSAPP_VERIFY_TOKEN: z.string().optional().default(''),
    META_APP_SECRET: z.string().optional().default(''),
    WHATSAPP_API_VERSION: z.string().default('v21.0'),

    OPENROUTER_API_KEY: z.string().optional().default(''),
    OPENROUTER_MODEL: z.string().default('openrouter/free'),
    /** The model that receives the actual image bytes when a customer sends a picture. Empty (the default) = the business's own chat model
     *  (which must then accept image input, as openai/gpt-4.1-mini does). Production evidence 2026-10-13: `openrouter/free` answers HTTP 404
     *  "model_unavailable" to image requests, so it is NOT a safe default for pictures. */
    OPENROUTER_VISION_MODEL: z.string().optional().default(''),
    /** Shared default list (comma-separated OpenRouter ids) of chat models tried — ONE of them — when a business's chat model fails for a
     *  model-specific reason (refused, provider error, rate limit, empty answer) or, if the id is free (price 0), after a 402. Empty = no
     *  fallback. A business can set its own in business_settings.open_router_fallback_models. Nothing paid is ever added by default:
     *  the shipped default is empty because every free endpoint was blocked by the account's data policy on 2026-10-14 (see docs). */
    OPENROUTER_FALLBACK_MODELS: z.string().optional().default(''),
    /** The AI routing layer (src/llm/aiRouter.ts): the whole chain of routes for ONE completion must finish within this budget, and at most
     *  this many routes are tried for one message (each with its own hard timeout; a known-failing route is skipped by its cooldown). */
    AI_ROUTING_BUDGET_MS: z.coerce.number().int().positive().default(45000),
    AI_ROUTE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(8).default(4),
    /** Built-in LOCAL inference route, shared by every business: an Ollama (or any OpenAI-compatible local runtime) reachable on the loopback
     *  or a private network, e.g. http://127.0.0.1:11434/v1 — never a public address. Empty = no local route. OLLAMA_MODELS is the
     *  comma-separated chat model list (smallest first); OLLAMA_VISION_MODELS the models that take pictures (empty = none). A CPU-only host is
     *  slow: the per-attempt timeout is OLLAMA_TIMEOUT_MS and the local route gets the COMPACT prompt (same facts, less text). */
    OLLAMA_BASE_URL: z.string().optional().default(''),
    OLLAMA_MODELS: z.string().optional().default(''),
    OLLAMA_VISION_MODELS: z.string().optional().default(''),
    OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(45000),
    /** Prompt size guards (characters): the knowledge base is selected by relevance within this budget, the history is trimmed to this budget,
     *  and at most this many business documents (each cut to this length) are pasted into a prompt. A prompt that grows without bound hits the
     *  provider's per-request token cap (OpenRouter answers HTTP 402 "Prompt tokens limit exceeded" when the credit is low). */
    KNOWLEDGE_PROMPT_CHARS: z.coerce.number().int().positive().default(16000),
    HISTORY_PROMPT_CHARS: z.coerce.number().int().positive().default(12000),
    DOCUMENTS_PROMPT_COUNT: z.coerce.number().int().positive().default(6),
    DOCUMENT_PROMPT_CHARS: z.coerce.number().int().positive().default(3000),
    /** One image-analysis call may take this long (the whole message still obeys AI_LOOP_TIMEOUT_MS). */
    VISION_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
    /** Pictures larger than this are not analysed (WhatsApp images are usually well under 2 MB). */
    VISION_MAX_IMAGE_BYTES: z.coerce.number().int().positive().default(6 * 1024 * 1024),
    /** Shared default for voice-note transcription: an audio-capable OpenRouter model id, or empty = voice notes are not transcribed (the
     *  customer is told so). A business can set its own in business_settings.open_router_audio_model. Nothing paid is chosen by default. */
    OPENROUTER_AUDIO_MODEL: z.string().optional().default(''),
    AUDIO_TIMEOUT_MS: z.coerce.number().int().positive().default(40000),
    AUDIO_MAX_BYTES: z.coerce.number().int().positive().default(16 * 1024 * 1024),
    OPENROUTER_SITE_URL: z.string().optional().default(''),
    OPENROUTER_APP_NAME: z.string().optional().default('WhatsApp AI Agent'),

    GOOGLE_CLIENT_EMAIL: z.string().optional().default(''),
    GOOGLE_PRIVATE_KEY: z.string().optional().default(''),
    GOOGLE_CALENDAR_ID: z.string().default('primary'),
    GOOGLE_PROJECT_ID: z.string().optional().default(''),

    BUSINESS_NAME: z.string().default('Rowad Alfa Auto Care'),
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
    /** Only messages newer than this many hours are sent to the model as context (the stored conversation itself is kept). */
    CONVERSATION_MEMORY_HOURS: z.coerce.number().int().positive().default(72),
    MAX_TOOL_ROUNDS: z.coerce.number().int().positive().default(4),
    OPENROUTER_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
    /** Total time one customer message may spend in the AI loop (all provider calls, retries and tool rounds included). */
    AI_LOOP_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
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

    // Email one-time codes for dashboard sign-in (second step after the
    // password), delivered through Resend. RESEND_OTP_ENABLED turns the step
    // on; the key and sender are read only on the server and never reach
    // the browser. With the step on but no key, sign-in fails CLOSED (no
    // session is ever created without a verified code) — it never falls
    // back to password-only.
    RESEND_API_KEY: z.string().optional().default(''),
    RESEND_FROM_EMAIL: z.string().optional().default(''),
    // Lets the assistant look up CURRENT public information (see src/tools/webSearch.ts). Set to false to switch it off everywhere.
    WEB_SEARCH_ENABLED: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() !== '' ? ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()) : undefined),
      z.boolean().default(true),
    ),
    RESEND_OTP_ENABLED: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() !== '' ? ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase()) : undefined),
      z.boolean().default(false),
    ),
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

    // OpenRouter credentials are mandatory ONLY in production. Meta Cloud API
    // credentials are mandatory ONLY in production AND only when the Meta
    // transport is selected — the QR transport never needs them.
    // Google Calendar is optional for deployments that do not enable it; in
    // that case calendar operations deliberately remain on the mock provider.
    // Development and
    // test never require them — this is what makes the legacy local backend safe to
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

    if (data.WHATSAPP_CONNECTION_METHOD !== 'meta') return;

    for (const key of META_CLOUD_API_REQUIRED_KEYS) {
      if (!data[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when NODE_ENV=production and WHATSAPP_CONNECTION_METHOD=meta`,
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
   * Selected WhatsApp transport ('qr' by default, or 'meta'). Only decides
   * which credentials env validation demands in production; the QR socket
   * and the Meta webhook/Graph client themselves are untouched by this flag.
   */
  whatsappConnectionMethod: raw.WHATSAPP_CONNECTION_METHOD as WhatsappConnectionMethod,
  usesMetaCloudApi: raw.WHATSAPP_CONNECTION_METHOD === 'meta',
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
  /**
   * Calendar is independently mockable when no complete Google service
   * account is configured. This permits a live WhatsApp/OpenRouter test
   * without inventing Google credentials or changing booking semantics when
   * Google is configured.
   */
  shouldUseMockCalendarProviders:
    raw.NODE_ENV !== 'production' || !raw.GOOGLE_CLIENT_EMAIL || !raw.GOOGLE_PRIVATE_KEY,
  /** Dashboard sign-in requires an emailed one-time code after the password (see src/dashboard/loginOtp.ts). */
  loginOtpEnabled: raw.RESEND_OTP_ENABLED,
};

export type Env = typeof env;
