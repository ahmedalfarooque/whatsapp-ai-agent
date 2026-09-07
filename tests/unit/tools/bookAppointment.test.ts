import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/calendar/booking', () => ({
  createEvent: vi.fn(),
}));

import { createEvent } from '../../../src/calendar/booking';
import { bookAppointmentHandler } from '../../../src/tools/bookAppointment';

describe('bookAppointmentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('books successfully when the calendar confirms the event', async () => {
    vi.mocked(createEvent).mockResolvedValue({ success: true, eventId: 'evt_1', htmlLink: 'https://cal/evt_1' });

    const result = await bookAppointmentHandler({
      startISO: '2025-06-10T10:00:00',
      durationMinutes: 30,
      serviceType: 'Consultation',
      customerName: 'Alice',
    });

    expect(result).toMatchObject({ success: true, eventId: 'evt_1' });
  });

  it('never claims success on a calendar conflict', async () => {
    vi.mocked(createEvent).mockResolvedValue({ success: false, conflict: true });

    const result = await bookAppointmentHandler({
      startISO: '2025-06-10T10:00:00',
      durationMinutes: 30,
      serviceType: 'Consultation',
      customerName: 'Alice',
    });

    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
  });

  it('rejects invalid/missing arguments without calling the calendar', async () => {
    const result = await bookAppointmentHandler({ startISO: '2025-06-10T10:00:00' });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid startISO datetime', async () => {
    const result = await bookAppointmentHandler({
      startISO: 'not-a-real-date',
      durationMinutes: 30,
      serviceType: 'Consultation',
      customerName: 'Alice',
    });
    expect(result.success).toBe(false);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('reports failure (not a crash) when the calendar integration throws', async () => {
    vi.mocked(createEvent).mockRejectedValue(new Error('Google API down'));
    const result = await bookAppointmentHandler({
      startISO: '2025-06-10T10:00:00',
      durationMinutes: 30,
      serviceType: 'Consultation',
      customerName: 'Alice',
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe('booking_failed');
  });
});
