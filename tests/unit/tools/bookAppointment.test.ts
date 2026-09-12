import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/calendar/booking', () => ({
  createEvent: vi.fn(),
}));

import { createEvent } from '../../../src/calendar/booking';
import { bookAppointmentHandler } from '../../../src/tools/bookAppointment';

const CTX = { conversationId: 1 };

describe('bookAppointmentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('books successfully when the calendar confirms the event', async () => {
    vi.mocked(createEvent).mockResolvedValue({ success: true, eventId: 'evt_1', htmlLink: 'https://cal/evt_1' });

    const result = await bookAppointmentHandler(
      {
        startISO: '2025-06-10T10:00:00',
        durationMinutes: 30,
        serviceType: 'Consultation',
        customerName: 'Alice',
      },
      CTX,
    );

    expect(result).toMatchObject({ success: true, eventId: 'evt_1' });
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 1 }));
  });

  it('never claims success on a calendar conflict', async () => {
    vi.mocked(createEvent).mockResolvedValue({ success: false, conflict: true });

    const result = await bookAppointmentHandler(
      {
        startISO: '2025-06-10T10:00:00',
        durationMinutes: 30,
        serviceType: 'Consultation',
        customerName: 'Alice',
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('rejects invalid/missing arguments without calling the calendar', async () => {
    const result = await bookAppointmentHandler({ startISO: '2025-06-10T10:00:00' }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid startISO datetime', async () => {
    const result = await bookAppointmentHandler(
      {
        startISO: 'not-a-real-date',
        durationMinutes: 30,
        serviceType: 'Consultation',
        customerName: 'Alice',
      },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('reports failure (not a crash) when the calendar integration throws', async () => {
    vi.mocked(createEvent).mockRejectedValue(new Error('Google API down'));
    const result = await bookAppointmentHandler(
      {
        startISO: '2025-06-10T10:00:00',
        durationMinutes: 30,
        serviceType: 'Consultation',
        customerName: 'Alice',
      },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('booking_failed');
  });

  it('surfaces an uncertain outcome distinctly — never as success, never as a plain conflict/failure', async () => {
    vi.mocked(createEvent).mockResolvedValue({ success: false, uncertain: true });

    const result = await bookAppointmentHandler(
      {
        startISO: '2025-06-10T10:00:00',
        durationMinutes: 30,
        serviceType: 'Consultation',
        customerName: 'Alice',
      },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(result.conflict).toBeFalsy();
    expect(result.error).toBeUndefined();
  });

  it(
    'two different textual representations of the exact same instant normalize to an identical startISO/endISO ' +
      '(so the idempotency/slot keys built from them are also identical)',
    async () => {
      vi.mocked(createEvent).mockResolvedValue({ success: true, eventId: 'evt_1' });

      await bookAppointmentHandler(
        { startISO: '2025-06-10T10:00:00', durationMinutes: 30, serviceType: 'Consultation', customerName: 'Alice' },
        CTX,
      );
      await bookAppointmentHandler(
        {
          startISO: '2025-06-10T10:00:00.000',
          durationMinutes: 30,
          serviceType: 'Consultation',
          customerName: 'Alice',
        },
        CTX,
      );

      const [firstCallArgs] = vi.mocked(createEvent).mock.calls[0];
      const [secondCallArgs] = vi.mocked(createEvent).mock.calls[1];
      expect(secondCallArgs.startISO).toBe(firstCallArgs.startISO);
      expect(secondCallArgs.endISO).toBe(firstCallArgs.endISO);
    },
  );
});
