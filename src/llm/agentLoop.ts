import { env } from '../config/env';
import { logger } from '../logger';
import { chatCompletion } from './openRouterClient';
import { AiResponseError } from './aiResponseError';
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

function safeParseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export interface RunAgentLoopParams {
  systemPrompt: string;
  history: ChatMessageForLlm[];
  /** Threaded through to every tool call so handlers (e.g. book_appointment) can scope idempotency to this conversation. */
  conversationId: number;
  maxToolRounds?: number;
}

/**
 * Runs the OpenRouter tool-calling loop: sends the conversation + available
 * tools, executes any tool_calls the model requests, feeds results back, and
 * repeats until the model returns a plain text answer or the round cap is
 * hit (guarding against a runaway/looping model).
 */
export async function runAgentLoop(params: RunAgentLoopParams): Promise<AgentLoopResult> {
  const maxRounds = params.maxToolRounds ?? env.MAX_TOOL_ROUNDS;
  const messages: ChatMessage[] = [
    { role: 'system', content: params.systemPrompt },
    ...historyToChatMessages(params.history),
  ];
  const generatedMessages: GeneratedMessage[] = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const tools = toolSchemasForAccount(currentAccountId());
    const response = await chatCompletion({ messages, tools: tools.length ? tools : undefined });
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
      const args = safeParseArgs(toolCall.function.arguments ?? '{}');

      let resultContent: string;
      // A tool runs only if THIS business is offered THAT tool (the original business: the calendar tools; a business with a
      // catalogue library: the catalogue search) — being offered one tool never unlocks another.
      const offered = toolSchemasForAccount(currentAccountId()).some((schema) => (schema.function as { name?: string }).name === toolName);
      if (!toolDef || !offered) {
        // Unknown, or a tool this business is not offered.
        logger.error({ toolName, account: currentAccountId() }, 'model requested an unknown or unavailable tool');
        resultContent = JSON.stringify({ error: `unknown tool: ${toolName}` });
      } else {
        try {
          const result = await toolDef.handler(args, { conversationId: params.conversationId });
          resultContent = JSON.stringify(result);
        } catch (error) {
          logger.error({ toolName, error }, 'tool handler threw an unexpected error');
          resultContent = JSON.stringify({ error: 'tool_execution_failed' });
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
