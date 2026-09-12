import { DateTime } from 'luxon';
import { z } from 'zod';
import { env } from '../config/env';
import { createEvent } from '../calendar/booking';
import { logger } from '../logger';
import type { ToolContext } from './index';

export const bookAppointmentSchema = {
  type: 'function' as const,
  function: {
    name: 'book_appointment',
    description:
      'Create a CONFIRMED calendar appointment. Only call this after the customer has explicitly confirmed the date, time, service, and their name — and only for a slot previously confirmed available via check_availability.',
    parameters: {
      type: 'object',
      properties: {
        startISO: {
          type: 'string',
          description: 'ISO 8601 start datetime, business local timezone, e.g. 2025-01-15T10:00:00',
        },
        durationMinutes: { type: 'integer', minimum: 15 },
        serviceType: { type: 'string', description: 'The service being booked, from business knowledge.' },
        customerName: { type: 'string' },
      },
      required: ['startISO', 'durationMinutes', 'serviceType', 'customerName'],
      additionalProperties: false,
    },
  },
};

const argsSchema = z.object({
  startISO: z.string().min(1),
  durationMinutes: z.number().int().positive().optional(),
  serviceType: z.string().min(1),
  customerName: z.string().min(1),
});

export interface BookAppointmentResult {
  success: boolean;
  conflict?: boolean;
  /**
   * The booking's outcome could not be determined (Google connectivity
   * issue) — it may or may not have actually gone through. Distinct from
   * `conflict` (we know the slot is taken) and from a plain failure (we
   * know it didn't happen). The model must not claim success OR failure —
   * see the system prompt's handling of this case.
   */
  uncertain?: boolean;
  eventId?: string;
  startISO?: string;
  endISO?: string;
  error?: string;
}

export async function bookAppointmentHandler(
  rawArgs: unknown,
  context: ToolContext,
): Promise<BookAppointmentResult> {
  const parsed = argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return { success: false, error: `invalid arguments: ${parsed.error.message}` };
  }

  const durationMinutes = parsed.data.durationMinutes ?? env.BOOKING_DURATION_MINUTES;
  const start = DateTime.fromISO(parsed.data.startISO, { zone: env.BUSINESS_TIMEZONE });

  if (!start.isValid) {
    return { success: false, error: `invalid startISO datetime: ${start.invalidExplanation}` };
  }

  const end = start.plus({ minutes: durationMinutes });

  try {
    // conversationId scopes the idempotency key — see src/calendar/booking.ts —
    // so a retried request for the exact same slot/service/customer from this
    // conversation is recognized as "the same logical booking" rather than a
    // brand new one, and never creates a second Google Calendar event.
    const result = await createEvent({
      conversationId: context.conversationId,
      summary: `${parsed.data.serviceType} — ${parsed.data.customerName}`,
      description: `Booked via WhatsApp AI agent for ${parsed.data.customerName}.`,
      startISO: start.toISO() as string,
      endISO: end.toISO() as string,
    });

    if (!result.success) {
      if ('uncertain' in result && result.uncertain) {
        return { success: false, uncertain: true };
      }
      return { success: false, conflict: true };
    }

    return {
      success: true,
      eventId: result.eventId,
      startISO: start.toISO() as string,
      endISO: end.toISO() as string,
    };
  } catch (error) {
    logger.error({ error, args: parsed.data }, 'book_appointment tool failed');
    return { success: false, error: 'booking_failed' };
  }
}
