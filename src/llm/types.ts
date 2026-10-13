/** One part of a multimodal user message (OpenAI-compatible shape OpenRouter accepts). An image is sent as a data URL with its bytes. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string;
}

export interface ChatCompletionResponse {
  id?: string;
  choices: ChatCompletionChoice[];
}

/** The text of a message's content whatever its shape (a string or content parts; image parts contribute nothing). */
export function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return '';
}
