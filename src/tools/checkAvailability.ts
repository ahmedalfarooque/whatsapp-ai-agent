import { z } from 'zod';
import { env } from '../config/env';
import { findFreeSlots } from '../calendar/availability';
import { logger } from '../logger';
import type { ToolContext } from './index';

export const checkAvailabilitySchema = {
  type: 'function' as const,
  function: {
    name: 'check_availability',
    description:
      'Check REAL open appointment slots on a given date. Always call this before telling a customer a time is available — never guess or assume availability.',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date to check, in YYYY-MM-DD format, in the business local timezone.',
        },
        durationMinutes: {
          type: 'integer',
          description: 'Requested appointment duration in minutes.',
          minimum: 15,
        },
      },
      required: ['date', 'durationMinutes'],
      additionalProperties: false,
    },
  },
};

const argsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  durationMinutes: z.number().int().positive().optional(),
});

export interface CheckAvailabilityResult {
  date: string;
  durationMinutes: number;
  slots: string[];
  error?: string;
}

export async function checkAvailabilityHandler(
  rawArgs: unknown,
  // check_availability is read-only and needs no per-conversation context,
  // but every tool handler shares the same (args, context) signature.
  _context: ToolContext,
): Promise<CheckAvailabilityResult> {
  const parsed = argsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      date: typeof (rawArgs as { date?: string })?.date === 'string' ? (rawArgs as { date: string }).date : '',
      durationMinutes: env.BOOKING_DURATION_MINUTES,
      slots: [],
      error: `invalid arguments: ${parsed.error.message}`,
    };
  }

  const durationMinutes = parsed.data.durationMinutes ?? env.BOOKING_DURATION_MINUTES;

  try {
    const slots = await findFreeSlots(parsed.data.date, durationMinutes);
    return {
      date: parsed.data.date,
      durationMinutes,
      slots: slots.map((s) => s.toISO() as string),
    };
  } catch (error) {
    logger.error({ error, args: parsed.data }, 'check_availability tool failed');
    return {
      date: parsed.data.date,
      durationMinutes,
      slots: [],
      error: 'availability_check_failed',
    };
  }
}
