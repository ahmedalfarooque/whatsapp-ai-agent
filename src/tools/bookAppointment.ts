import { DateTime } from 'luxon';
import { z } from 'zod';
import { env } from '../config/env';
import { createEvent } from '../calendar/booking';
import { logger } from '../logger';

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
  eventId?: string;
  startISO?: string;
  endISO?: string;
  error?: string;
}

export async function bookAppointmentHandler(rawArgs: unknown): Promise<BookAppointmentResult> {
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
    const result = await createEvent({
      summary: `${parsed.data.serviceType} — ${parsed.data.customerName}`,
      description: `Booked via WhatsApp AI agent for ${parsed.data.customerName}.`,
      startISO: start.toISO() as string,
      endISO: end.toISO() as string,
    });

    if (!result.success) {
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
