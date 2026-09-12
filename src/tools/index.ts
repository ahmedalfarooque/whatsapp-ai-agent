import { TOOL_NAMES } from '../config/constants';
import { checkAvailabilitySchema, checkAvailabilityHandler } from './checkAvailability';
import { bookAppointmentSchema, bookAppointmentHandler } from './bookAppointment';

/** Context available to every tool handler, independent of whatever the LLM supplied as arguments. */
export interface ToolContext {
  conversationId: number;
}

export type ToolHandler = (args: unknown, context: ToolContext) => Promise<unknown>;

export interface ToolDefinition {
  schema: { type: 'function'; function: Record<string, unknown> };
  handler: ToolHandler;
}

/**
 * Registry of tools exposed to the LLM. Only tools with a real, working
 * implementation are registered here — never a stub the model could be
 * tricked into believing succeeded.
 */
export const toolRegistry: Record<string, ToolDefinition> = {
  [TOOL_NAMES.CHECK_AVAILABILITY]: {
    schema: checkAvailabilitySchema,
    handler: checkAvailabilityHandler,
  },
  [TOOL_NAMES.BOOK_APPOINTMENT]: {
    schema: bookAppointmentSchema,
    handler: bookAppointmentHandler,
  },
};

export const toolSchemas = Object.values(toolRegistry).map((t) => t.schema);
