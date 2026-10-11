import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/llm/openRouterClient', () => ({ chatCompletion: vi.fn() }));
vi.mock('../../../src/tools/bookAppointment', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/tools/bookAppointment')>();
  return { ...real, bookAppointmentHandler: vi.fn(async () => ({ success: true, eventId: 'evt_1' })) };
});
vi.mock('../../../src/tools/checkAvailability', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/tools/checkAvailability')>();
  return { ...real, checkAvailabilityHandler: vi.fn(async () => ({ slots: ['2030-01-01T10:00:00Z'] })) };
});

import { chatCompletion } from '../../../src/llm/openRouterClient';
import { bookAppointmentHandler } from '../../../src/tools/bookAppointment';
import { checkAvailabilityHandler } from '../../../src/tools/checkAvailability';
import { runAgentLoop } from '../../../src/llm/agentLoop';
import { canonicalArguments, validateToolArguments } from '../../../src/llm/toolArgs';
import { getDb } from '../../../src/memory/db';

const call = (name: string, args: unknown, id = 'call_1') => ({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] } }],
});
const say = (content: string) => ({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
const VALID_BOOKING = { startISO: '2030-01-01T10:00:00Z', durationMinutes: 30, serviceType: 'Consultation', customerName: 'Sara' };

/** Runs one loop (the original business, which owns the calendar tools) and returns what the model was told after each tool call. */
async function run(responses: unknown[], extra: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  for (const r of responses) vi.mocked(chatCompletion).mockResolvedValueOnce(r as never);
  const result = await runAgentLoop({ systemPrompt: 'sys', history: [], conversationId: 1, ...extra });
  return { result, toolResults: result.generatedMessages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content) as Record<string, unknown>) };
}

beforeEach(() => {
  getDb();
  vi.clearAllMocks();
});

describe('validateToolArguments', () => {
  const schema = { type: 'object', required: ['n', 'name'], properties: { n: { type: 'integer', minimum: 15, maximum: 60 }, name: { type: 'string', minLength: 1 }, mode: { type: 'string', enum: ['a', 'b'] } } };
  it('accepts valid arguments and reports each problem in plain words', () => {
    expect(validateToolArguments(schema, { n: 30, name: 'x', mode: 'a' })).toEqual([]);
    expect(validateToolArguments(schema, { n: 5 })).toEqual(['arguments.name is required', 'arguments.n must be at least 15']);
    expect(validateToolArguments(schema, { n: '30', name: 'x' })).toEqual(['arguments.n must be integer']);
    expect(validateToolArguments(schema, { n: 30, name: 'x', mode: 'c' })).toEqual(['arguments.mode must be one of: a, b']);
    expect(validateToolArguments(schema, [])).toEqual(['arguments must be object']);
    expect(validateToolArguments(schema, { n: 30, name: 'x', extra: 'ignored' })).toEqual([]);
  });
  it('canonicalArguments ignores key order', () => {
    expect(canonicalArguments({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalArguments({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalArguments({ a: 1 })).not.toBe(canonicalArguments({ a: 2 }));
  });
});

describe('the agent loop around tools', () => {
  it('runs a valid call once and lets the model answer from its result', async () => {
    const { result, toolResults } = await run([call('book_appointment', VALID_BOOKING), say('You are booked for Tuesday at 10.')]);
    expect(bookAppointmentHandler).toHaveBeenCalledTimes(1);
    expect(toolResults[0]).toMatchObject({ success: true });
    expect(result.finalText).toBe('You are booked for Tuesday at 10.');
  });

  it('refuses invalid arguments before the handler runs and tells the model the action did NOT happen', async () => {
    const { toolResults } = await run([call('book_appointment', { startISO: '2030-01-01T10:00:00Z', durationMinutes: 5 }), say('Which service and name should I use?')]);
    expect(bookAppointmentHandler).not.toHaveBeenCalled();
    expect(toolResults[0]).toMatchObject({ error: 'invalid_arguments' });
    expect(JSON.stringify(toolResults[0])).toMatch(/durationMinutes must be at least 15/);
    expect(JSON.stringify(toolResults[0])).toMatch(/did NOT complete/);
  });

  it('arguments that are not JSON are reported, never silently turned into an empty object', async () => {
    const { toolResults } = await run([call('check_availability', '{not json'), say('ok')]);
    expect(checkAvailabilityHandler).not.toHaveBeenCalled();
    expect(toolResults[0]).toMatchObject({ error: 'invalid_arguments' });
  });

  it('a handler that throws returns an explicit "did not complete" result with no internal detail', async () => {
    vi.mocked(bookAppointmentHandler).mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.5:5432 secret-internal-detail'));
    const { toolResults } = await run([call('book_appointment', VALID_BOOKING), say('I could not complete the booking; shall I connect you with the team?')]);
    expect(toolResults[0]).toMatchObject({ error: 'tool_execution_failed' });
    expect(JSON.stringify(toolResults[0])).not.toMatch(/ECONNREFUSED|secret-internal-detail|10\.0\.0\.5/);
    expect(JSON.stringify(toolResults[0])).toMatch(/did NOT complete/);
  });

  it('an identical repeated call is answered from the first result and never executed twice', async () => {
    const { result, toolResults } = await run([call('book_appointment', VALID_BOOKING, 'c1'), call('book_appointment', { customerName: 'Sara', serviceType: 'Consultation', durationMinutes: 30, startISO: '2030-01-01T10:00:00Z' }, 'c2'), say('Done.')]);
    expect(bookAppointmentHandler).toHaveBeenCalledTimes(1);
    expect(toolResults[1]).toMatchObject({ duplicate_call: true, earlier_result: { success: true, eventId: 'evt_1' } });
    expect(result.finalText).toBe('Done.');
  });

  it('a different call with different arguments still runs', async () => {
    await run([call('check_availability', { date: '2030-01-01', durationMinutes: 30 }, 'c1'), call('check_availability', { date: '2030-01-02', durationMinutes: 30 }, 'c2'), say('Two days checked.')]);
    expect(checkAvailabilityHandler).toHaveBeenCalledTimes(2);
  });

  it('passes one shared deadline to every provider call and stops when the time budget is gone', async () => {
    vi.mocked(chatCompletion).mockResolvedValueOnce(call('check_availability', { date: '2030-01-01', durationMinutes: 30 }) as never);
    vi.mocked(checkAvailabilityHandler).mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return { slots: [] };
    });
    await expect(runAgentLoop({ systemPrompt: 's', history: [], conversationId: 1, timeBudgetMs: 10 })).rejects.toMatchObject({ reason: 'time_budget_exceeded' });
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    const first = vi.mocked(chatCompletion).mock.calls[0]![0];
    expect(typeof first.deadline).toBe('number');
  });

  it('every call in one loop shares the same deadline', async () => {
    await run([call('check_availability', { date: '2030-01-01', durationMinutes: 30 }), say('free at 10')]);
    const deadlines = vi.mocked(chatCompletion).mock.calls.map(([r]) => r.deadline);
    expect(deadlines).toHaveLength(2);
    expect(deadlines[0]).toBe(deadlines[1]);
  });
});
