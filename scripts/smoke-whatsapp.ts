import { env } from '../src/config/env';
import { sendTextMessage } from '../src/whatsapp/client';

/* eslint-disable no-console */

async function main(): Promise<void> {
  if (!env.isProduction) throw new Error('Set NODE_ENV=production for the WhatsApp smoke test.');
  const recipient = process.env.SMOKE_WHATSAPP_RECIPIENT;
  if (!recipient) throw new Error('SMOKE_WHATSAPP_RECIPIENT is required; no recipient is inferred.');
  if (process.env.CONFIRM_LIVE_WHATSAPP_SEND !== 'true') {
    throw new Error('Set CONFIRM_LIVE_WHATSAPP_SEND=true to permit an outbound WhatsApp message.');
  }

  const result = await sendTextMessage(recipient, 'WhatsApp AI Agent live smoke test.');
  console.log(JSON.stringify({ ok: true, recipient, messageId: result.messages?.[0]?.id ?? null }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'WhatsApp smoke test failed');
  process.exitCode = 1;
});
