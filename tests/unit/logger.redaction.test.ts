import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_PATHS } from '../../src/logger';

function capture(): { log: pino.Logger; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); } });
  return { log: pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream), text: () => chunks.join('') };
}

describe('logger redaction', () => {
  it('never writes session cookies, bearer tokens or signatures from request/response headers', () => {
    const { log, text } = capture();
    log.info({
      req: { headers: { cookie: 'dashboard_session=REQ-COOKIE-SECRET', authorization: 'Bearer BEARER-SECRET', 'x-hub-signature-256': 'sha256=SIG-SECRET', 'user-agent': 'ok-ua' } },
      res: { headers: { 'set-cookie': 'dashboard_session=RES-COOKIE-SECRET; HttpOnly', 'content-type': 'application/json' } },
    }, 'request completed');
    const out = text();
    for (const secret of ['REQ-COOKIE-SECRET', 'BEARER-SECRET', 'SIG-SECRET', 'RES-COOKIE-SECRET']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('ok-ua'); // ordinary diagnostics stay readable
    expect(out).toContain('application/json');
  });
});
