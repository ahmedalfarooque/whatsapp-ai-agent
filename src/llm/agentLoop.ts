import { env } from '../config/env';
import { logger } from '../logger';
import { chatCompletion } from './openRouterClient';
import { AiResponseError } from './aiResponseError';
import { canonicalArguments, validateToolArguments } from './toolArgs';
import { toolRegistry, toolSchemasForAccount } from '../tools';
import { currentAccountId } from '../accounts/accountContext';
import type { ChatMessage } from './types';
import type { ChatMessageForLlm } from '../memory/conversationRepo';

export interface GeneratedMessage {
  role: 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface AgentLoopResult {
  finalText: string;
  generatedMessages: GeneratedMessage[];
}

function historyToChatMessages(history: ChatMessageForLlm[]): ChatMessage[] {
  return history.map((h) => ({
    role: h.role,
    content: h.content,
    tool_call_id: h.tool_call_id,
    name: h.tool_name,
  }));
}

/** Parses the model's argument string. `null` means it was not valid JSON: that is reported to the model, never silently turned into {}. */
function parseArgs(raw: string | undefined): unknown | null {
  if (raw === undefined || raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// What the MODEL is told when a tool did not do its job. Customer-facing text is written by the model afterwards, so every message says
// plainly that the action did NOT happen; none of it is ever sent to the customer as-is.
const NOT_DONE = 'The action did NOT complete. Do not tell the customer it was done, saved or booked. Apologise briefly and offer to connect them with the team.';

export interface RunAgentLoopParams {
  systemPrompt: string;
  history: ChatMessageForLlm[];
  /** Threaded through to every tool call so handlers (e.g. book_appointment) can scope idempotency to this conversation. */
  conversationId: number;
  maxToolRounds?: number;
  /** Total time allowed for the whole loop, in ms (default AI_LOOP_TIMEOUT_MS). */
  timeBudgetMs?: number;
}

/**
 * Runs the OpenRouter tool-calling loop: sends the conversation + available tools, executes the tool calls the model requests, feeds
 * the results back, and repeats until the model returns a plain text answer. It is bounded three ways — a round cap, a total time
 * budget (provider retries included), and no repeated identical call — and it never reports a success the tools did not produce:
 *  - arguments are validated against the tool's own schema before the handler runs;
 *  - a tool that is unknown, not offered to this business, given bad arguments or that throws returns an explicit "did not complete"
 *    result to the model (no internal detail), and an identical repeated call is answered from the first result instead of re-running;
 *  - exhausting the rounds or the time is a FAILED answer (the pipeline sends its neutral fallback), not a made-up reply.
 */
export async function runAgentLoop(params: RunAgentLoopParams): Promise<AgentLoopResult> {
  const maxRounds = params.maxToolRounds ?? env.MAX_TOOL_ROUNDS;
  const deadline = Date.now() + (params.timeBudgetMs ?? env.AI_LOOP_TIMEOUT_MS);
  const messages: ChatMessage[] = [
    { role: 'system', content: params.systemPrompt },
    ...historyToChatMessages(params.history),
  ];
  const generatedMessages: GeneratedMessage[] = [];
  const executed = new Map<string, string>(); // canonical call -> the result it produced

  for (let round = 1; round <= maxRounds; round += 1) {
    if (Date.now() >= deadline) {
      logger.warn({ round, account: currentAccountId() }, 'agent loop ran out of its time budget');
      throw new AiResponseError('time_budget_exceeded', null, null);
    }
    const accountTools = toolSchemasForAccount(currentAccountId());
    const response = await chatCompletion({ messages, tools: accountTools.length ? accountTools : undefined, deadline });
    const choice = response.choices[0];
    if (!choice) {
      throw new AiResponseError('malformed_response', null, null);
    }
    const assistantMessage = choice.message;

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      // An empty answer is a FAILED answer (the client already rejects it; this guards any other caller): it must never be stored or
      // counted as a successful AI reply.
      const finalText = assistantMessage.content?.trim();
      if (!finalText) throw new AiResponseError('empty_response', null, null);
      generatedMessages.push({ role: 'assistant', content: finalText });
      return { finalText, generatedMessages };
    }

    messages.push(assistantMessage);
    const toolSummary = toolCalls.map((tc) => tc.function.name).join(', ');
    generatedMessages.push({
      role: 'assistant',
      content: `[requested tools: ${toolSummary}]`,
    });

    for (const toolCall of toolCalls) {
      const toolName = toolCall.function.name;
      const toolDef = toolRegistry[toolName];
      const args = parseArgs(toolCall.function.arguments);

      let resultContent: string;
      // A tool runs only if THIS business is offered THAT tool (the original business: the calendar tools; a business with a
      // catalogue library: the catalogue search) — being offered one tool never unlocks another.
      const offered = accountTools.find((schema) => (schema.function as { name?: string }).name === toolName);
      if (!toolDef || !offered) {
        // Unknown, or a tool this business is not offered.
        logger.error({ toolName, account: currentAccountId() }, 'model requested an unknown or unavailable tool');
        resultContent = JSON.stringify({ error: 'unknown_tool', note: `There is no tool called ${toolName}. ${NOT_DONE}` });
      } else if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        resultContent = JSON.stringify({ error: 'invalid_arguments', details: ['the arguments were not a JSON object'], note: `Call the tool again with valid arguments, or ask the customer for the missing details. ${NOT_DONE}` });
      } else {
        const problems = validateToolArguments((offered.function as { parameters?: never }).parameters, args);
        const callKey = `${toolName}:${canonicalArguments(args)}`;
        const previous = executed.get(callKey);
        if (problems.length > 0) {
          logger.warn({ toolName, account: currentAccountId(), problems }, 'model supplied invalid tool arguments');
          resultContent = JSON.stringify({ error: 'invalid_arguments', details: problems, note: `Fix the arguments, or ask the customer for the missing details. ${NOT_DONE}` });
        } else if (previous !== undefined) {
          // The same call again: running it twice could double an action, and asking twice cannot give a different answer.
          resultContent = JSON.stringify({ duplicate_call: true, earlier_result: JSON.parse(previous) as unknown, note: 'You already made exactly this call. Use the earlier result and answer the customer now.' });
        } else {
          try {
            const result = await toolDef.handler(args, { conversationId: params.conversationId });
            resultContent = JSON.stringify(result);
            executed.set(callKey, resultContent);
          } catch (error) {
            logger.error({ toolName, errorName: (error as Error)?.name }, 'tool handler threw an unexpected error');
            resultContent = JSON.stringify({ error: 'tool_execution_failed', note: NOT_DONE });
          }
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolName,
        content: resultContent,
      });
      generatedMessages.push({
        role: 'tool',
        content: resultContent,
        toolCallId: toolCall.id,
        toolName,
      });
    }
  }

  // The model kept requesting tools and never answered: that is a failed answer, handled like any other AI failure (fallback template,
  // logged as an error) rather than a made-up "success".
  logger.warn({ maxRounds }, 'agent loop exhausted max tool rounds without a final answer');
  throw new AiResponseError('tool_rounds_exhausted', null, null);
}
