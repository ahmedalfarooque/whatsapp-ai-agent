export const TOOL_NAMES = {
  CHECK_AVAILABILITY: 'check_availability',
  BOOK_APPOINTMENT: 'book_appointment',
  GET_BUSINESS_INFORMATION: 'get_business_information',
} as const;

export const CONVERSATION_STATUS = {
  ACTIVE: 'active',
  ENDED: 'ended',
} as const;

export const BOOKING_STATUS = {
  IN_PROGRESS: 'in_progress',
  CONFIRMED: 'confirmed',
  ABANDONED: 'abandoned',
} as const;

export const MESSAGE_ROLE = {
  USER: 'user',
  ASSISTANT: 'assistant',
  TOOL: 'tool',
  SYSTEM: 'system',
} as const;

export const MESSAGE_DIRECTION = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
} as const;

/** Safe, generic message shown to customers when something goes wrong internally. */
export const GENERIC_ERROR_REPLY =
  "Sorry, something went wrong on our end. Please try again in a moment, or contact us directly if this keeps happening.";
