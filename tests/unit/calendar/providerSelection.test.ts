import { describe, it, expect, vi, afterEach } from 'vitest';

async function withIsolatedEnv(mutate: () => void, run: () => Promise<void>) {
  const snapshot = { ...process.env };
  try {
    mutate();
    vi.resetModules();
    await run();
  } finally {
    process.env = snapshot;
    vi.resetModules();
  }
}

const freebusyQuery = vi.fn().mockResolvedValue({ data: { calendars: {} } });
const eventsInsert = vi.fn().mockResolvedValue({ data: { id: 'real-event-id', htmlLink: 'https://cal/real' } });

vi.mock('../../../src/calendar/googleClient', () => ({
  getCalendarClient: () => ({
    freebusy: { query: freebusyQuery },
    events: { insert: eventsInsert },
  }),
}));

function setAllProductionCreds() {
  process.env.NODE_ENV = 'production';
  process.env.WHATSAPP_ACCESS_TOKEN = 'real-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'real-phone-id';
  process.env.WHATSAPP_VERIFY_TOKEN = 'real-verify-token';
  process.env.META_APP_SECRET = 'real-app-secret';
  process.env.OPENROUTER_API_KEY = 'real-openrouter-key';
  process.env.GOOGLE_CLIENT_EMAIL = 'real@example.iam.gserviceaccount.com';
  process.env.GOOGLE_PRIVATE_KEY = 'real-private-key';
}

describe('Calendar provider selection', () => {
  afterEach(() => {
    freebusyQuery.mockClear();
    eventsInsert.mockClear();
  });

  it('development mode never constructs the real Google client — uses the mock', async () => {
    await withIsolatedEnv(
      () => {
        process.env.NODE_ENV = 'development';
      },
      async () => {
        const { freeBusyQuery } = await import('../../../src/calendar/availability');
        const { createEvent } = await import('../../../src/calendar/booking');

        const busy = await freeBusyQuery('2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z');
        const created = await createEvent({
          conversationId: 1,
          summary: 'Test',
          startISO: '2025-01-01T10:00:00',
          endISO: '2025-01-01T10:30:00',
        });

        expect(freebusyQuery).not.toHaveBeenCalled();
        expect(eventsInsert).not.toHaveBeenCalled();
        expect(busy).toEqual([]);
        expect(created.success).toBe(true);
        if (created.success) expect(created.eventId).toMatch(/^mock-event-/);
      },
    );
  });

  it('production mode calls the real Google Calendar client', async () => {
    await withIsolatedEnv(setAllProductionCreds, async () => {
      const { getOrCreateCustomer } = await import('../../../src/memory/customerRepo');
      const { getOrCreateActiveConversation } = await import('../../../src/memory/conversationRepo');
      const { createEvent } = await import('../../../src/calendar/booking');

      const customer = getOrCreateCustomer('15551234567', 'Alice');
      const conversation = getOrCreateActiveConversation(customer.id);

      const result = await createEvent({
        conversationId: conversation.id,
        summary: 'Test',
        startISO: '2025-01-01T10:00:00',
        endISO: '2025-01-01T10:30:00',
      });

      expect(freebusyQuery).toHaveBeenCalled();
      expect(eventsInsert).toHaveBeenCalled();
      expect(result.success).toBe(true);
      if (result.success) expect(result.eventId).toBe('real-event-id');
    });
  });
});
