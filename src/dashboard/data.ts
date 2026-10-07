import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { getDb } from '../memory/db';
import { maskWaId } from '../logger';
import { listBookingLocks } from '../memory/bookingLockRepo';
import { listKnowledgeFiles, knowledgeDirForAccount } from './knowledgeAdmin';
import { getEffectiveCredential } from '../config/effectiveConfig';
import { getBusinessSettings, getBusinessSettingsOverrides } from '../config/businessSettings';
import { currentAccountId } from '../accounts/accountContext';

export interface DashboardSummary {
  customers: number;
  conversations: number;
  bookings: number;
  aiRequests: number;
}

export interface ServiceStatus {
  name: string;
  state: 'Development Mock' | 'Production' | 'Connected' | 'Available' | 'Not configured';
  detail: string;
}

function count(sql: string, accountId: number): number {
  return (getDb().prepare(sql).get(accountId) as { count: number }).count;
}

/** Counts for ONE business (the selected WhatsApp account). */
export function getDashboardSummary(accountId: number = currentAccountId()): DashboardSummary {
  return {
    customers: count('SELECT COUNT(*) AS count FROM customers WHERE whatsapp_account_id = ?', accountId),
    conversations: count('SELECT COUNT(*) AS count FROM conversations WHERE whatsapp_account_id = ?', accountId),
    // booking_locks (not booking_sessions) is where the real booking flow
    // (src/calendar/booking.ts) actually records a confirmed appointment.
    bookings: count(
      "SELECT COUNT(*) AS count FROM booking_locks bl JOIN conversations c ON c.id = bl.conversation_id WHERE bl.status = 'confirmed' AND c.whatsapp_account_id = ?",
      accountId,
    ),
    aiRequests: count(
      "SELECT COUNT(*) AS count FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'assistant' AND c.whatsapp_account_id = ?",
      accountId,
    ),
  };
}

export function getServiceStatuses(): ServiceStatus[] {
  const mockLabel = env.shouldUseMockProviders;
  return [
    {
      name: 'WhatsApp',
      state: mockLabel ? 'Development Mock' : 'Production',
      detail: mockLabel ? 'No real messages are sent' : `Configured (API ${env.WHATSAPP_API_VERSION})`,
    },
    {
      name: 'OpenRouter',
      state: mockLabel ? 'Development Mock' : 'Production',
      detail: mockLabel ? 'No real AI calls are made' : `Configured (model: ${getBusinessSettings().openRouterModel})`,
    },
    {
      name: 'Google Calendar',
      state: mockLabel ? 'Development Mock' : 'Production',
      detail: mockLabel ? 'No real calendar calls are made' : `Configured (calendar: ${env.GOOGLE_CALENDAR_ID})`,
    },
    { name: 'SQLite', state: 'Connected', detail: env.DATABASE_PATH },
    { name: 'AI Agent', state: 'Available', detail: 'Webhook pipeline loaded' },
  ];
}

export function getKnowledgeStatus(accountId: number = currentAccountId()): Array<{ name: string; status: string }> {
  return listKnowledgeFiles(accountId).map((f) => ({ name: f.name, status: f.exists ? 'Available' : 'Missing' }));
}

export interface RecentConversationItem {
  id: number;
  customer: string;
  status: string;
  lastMessage: string | null;
  updatedAt: string | null;
}

export function getRecentConversations(limit = 8, accountId: number = currentAccountId()): RecentConversationItem[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.status, c.started_at,
              MAX(m.created_at) AS last_message_at,
              cu.display_name, cu.wa_id,
              (SELECT content FROM conversation_messages WHERE conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_message
       FROM conversations c
       JOIN customers cu ON cu.id = c.customer_id
       LEFT JOIN conversation_messages m ON m.conversation_id = c.id
       WHERE c.whatsapp_account_id = ?
       GROUP BY c.id
       ORDER BY COALESCE(last_message_at, c.started_at) DESC
       LIMIT ?`,
    )
    .all(accountId, Math.max(1, Math.min(limit, 50))) as Array<{
    id: number;
    status: string;
    display_name: string | null;
    wa_id: string;
    last_message: string | null;
    last_message_at: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    customer: row.display_name || maskWaId(row.wa_id),
    status: row.status,
    lastMessage: row.last_message,
    updatedAt: row.last_message_at,
  }));
}

export interface UpcomingBookingItem {
  id: number;
  service: string | null;
  customer: string;
  date: string | null;
  time: string | null;
  status: string;
}

export function getUpcomingBookings(limit = 8): UpcomingBookingItem[] {
  const { items } = listBookingLocks({ status: 'confirmed', limit });
  return items.map((row) => {
    const [date, time] = row.start_iso.split('T');
    return {
      id: row.id,
      service: null,
      customer: row.customerLabel || maskWaId(row.waId),
      date: date ?? null,
      time: time ? time.slice(0, 5) : null,
      status: row.status,
    };
  });
}

export interface AiConfigView {
  mode: 'development' | 'production' | 'test';
  providerMode: 'mock' | 'production';
  model: string;
  maxToolRounds: number;
  conversationHistoryLimit: number;
  toolsEnabled: string[];
  timeouts: { openRouterMs: number };
}

export function getAiConfig(): AiConfigView {
  return {
    mode: env.NODE_ENV,
    providerMode: env.shouldUseMockProviders ? 'mock' : 'production',
    model: getBusinessSettings().openRouterModel,
    maxToolRounds: env.MAX_TOOL_ROUNDS,
    conversationHistoryLimit: getBusinessSettings().conversationHistoryLimit,
    toolsEnabled: ['check_availability', 'book_appointment'],
    timeouts: { openRouterMs: env.OPENROUTER_TIMEOUT_MS },
  };
}

export interface IntegrationView {
  name: string;
  state: string;
  configured: boolean;
  detail: string;
}

export function getIntegrations(): IntegrationView[] {
  const mock = env.shouldUseMockProviders;
  const whatsappConfigured = Boolean(
    getEffectiveCredential('WHATSAPP_ACCESS_TOKEN') && getEffectiveCredential('WHATSAPP_PHONE_NUMBER_ID'),
  );
  const openRouterConfigured = Boolean(getEffectiveCredential('OPENROUTER_API_KEY'));
  const googleConfigured = Boolean(
    getEffectiveCredential('GOOGLE_CLIENT_EMAIL') && getEffectiveCredential('GOOGLE_PRIVATE_KEY'),
  );

  return [
    {
      name: 'WhatsApp Cloud API',
      state: mock ? 'Development Mock' : whatsappConfigured ? 'Configured' : 'Missing configuration',
      configured: whatsappConfigured,
      detail: `Graph API ${env.WHATSAPP_API_VERSION}`,
    },
    {
      name: 'OpenRouter',
      state: mock ? 'Development Mock' : openRouterConfigured ? 'Configured' : 'Missing configuration',
      configured: openRouterConfigured,
      detail: `Model: ${getBusinessSettings().openRouterModel}`,
    },
    {
      name: 'Google Calendar',
      state: mock ? 'Development Mock' : googleConfigured ? 'Configured' : 'Missing configuration',
      configured: googleConfigured,
      detail: `Calendar ID: ${env.GOOGLE_CALENDAR_ID}`,
    },
  ];
}

export interface SystemInfoView {
  environment: string;
  providerMode: string;
  uptimeSeconds: number;
  nodeVersion: string;
  databasePath: string;
  databaseReachable: boolean;
  knowledgeFilesAvailable: number;
  knowledgeFilesTotal: number;
}

export function getSystemInfo(): SystemInfoView {
  let databaseReachable = true;
  try {
    getDb().prepare('SELECT 1').get();
  } catch {
    databaseReachable = false;
  }
  const knowledge = getKnowledgeStatus();

  return {
    environment: env.NODE_ENV,
    providerMode: env.shouldUseMockProviders ? 'mock' : 'production',
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    databasePath: env.DATABASE_PATH,
    databaseReachable,
    knowledgeFilesAvailable: knowledge.filter((k) => k.status === 'Available').length,
    knowledgeFilesTotal: knowledge.length,
  };
}

export interface SettingsView {
  business: {
    name: string;
    timezone: string;
    hoursStart: string;
    hoursEnd: string;
    days: number[];
  };
  booking: { durationMinutes: number; bufferMinutes: number };
  agent: { restartKeywords: string[]; conversationHistoryLimit: number };
  content: {
    welcomeMessage: string | null;
    fallbackMessage: string | null;
    cancellationPolicy: string | null;
    humanEscalationInfo: string | null;
    supportedLanguages: string[];
  };
  security: { rateLimitPerMinute: number; maxBodySize: string };
  /** Which editable fields are currently a dashboard override vs. an env fallback. */
  overrides: ReturnType<typeof getBusinessSettingsOverrides>;
}

export function getSettingsView(): SettingsView {
  const settings = getBusinessSettings();
  return {
    business: {
      name: settings.businessName,
      timezone: settings.businessTimezone,
      hoursStart: settings.businessHoursStart,
      hoursEnd: settings.businessHoursEnd,
      days: settings.businessDays,
    },
    booking: { durationMinutes: settings.bookingDurationMinutes, bufferMinutes: settings.bookingBufferMinutes },
    agent: { restartKeywords: settings.restartKeywords, conversationHistoryLimit: settings.conversationHistoryLimit },
    content: {
      welcomeMessage: settings.welcomeMessage,
      fallbackMessage: settings.fallbackMessage,
      cancellationPolicy: settings.cancellationPolicy,
      humanEscalationInfo: settings.humanEscalationInfo,
      supportedLanguages: settings.supportedLanguages,
    },
    security: { rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE, maxBodySize: env.MAX_BODY_SIZE },
    overrides: getBusinessSettingsOverrides(),
  };
}

export interface ServicesView {
  sourceFile: string;
  available: boolean;
  content: string | null;
}

/** Services are derived from the account's knowledge/services.md — there is no separate services database. */
export function getServicesView(accountId: number = currentAccountId()): ServicesView {
  const filePath = path.join(knowledgeDirForAccount(accountId), 'services.md');
  if (!fs.existsSync(filePath)) {
    return { sourceFile: 'services.md', available: false, content: null };
  }
  // The markers that let Analyze & Generate refresh its own block are bookkeeping, not content for people to read.
  const content = fs.readFileSync(filePath, 'utf-8').replace(/<!-- setup:(?:begin v1 hash=[0-9a-f]+|end) -->\n?/g, '');
  return { sourceFile: 'services.md', available: true, content };
}
