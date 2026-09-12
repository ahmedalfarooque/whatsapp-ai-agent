import { env } from '../src/config/env';
import { chatCompletion } from '../src/llm/openRouterClient';

/* eslint-disable no-console */

async function main(): Promise<void> {
  if (!env.isProduction) throw new Error('Set NODE_ENV=production for the OpenRouter smoke test.');
  if (!env.OPENROUTER_API_KEY || !env.OPENROUTER_MODEL) {
    throw new Error('OPENROUTER_API_KEY and OPENROUTER_MODEL are required.');
  }

  const response = await chatCompletion({
    messages: [{ role: 'user', content: 'Reply with exactly: OPENROUTER_SMOKE_OK' }],
    temperature: 0,
    maxTokens: 20,
  });
  const text = response.choices[0]?.message?.content ?? '';
  console.log(JSON.stringify({ ok: true, model: env.OPENROUTER_MODEL, responsePreview: text.slice(0, 80) }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'OpenRouter smoke test failed');
  process.exitCode = 1;
});
