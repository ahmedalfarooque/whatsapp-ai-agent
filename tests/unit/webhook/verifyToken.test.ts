import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { handleWebhookVerification } from '../../../src/webhook/verifyToken';

function makeReqRes(query: Record<string, string>) {
  const req = { query } as unknown as Request;
  const send = vi.fn();
  const status = vi.fn().mockReturnValue({ send });
  const sendStatus = vi.fn();
  const res = { status, sendStatus } as unknown as Response;
  return { req, res, send, status, sendStatus };
}

describe('handleWebhookVerification', () => {
  it('echoes hub.challenge with 200 for a matching verify token', () => {
    const { req, res, status, send } = makeReqRes({
      'hub.mode': 'subscribe',
      'hub.verify_token': process.env.WHATSAPP_VERIFY_TOKEN as string,
      'hub.challenge': 'challenge-123',
    });

    handleWebhookVerification(req, res);

    expect(status).toHaveBeenCalledWith(200);
    expect(send).toHaveBeenCalledWith('challenge-123');
  });

  it('rejects with 403 for a wrong verify token', () => {
    const { req, res, sendStatus } = makeReqRes({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge-123',
    });

    handleWebhookVerification(req, res);

    expect(sendStatus).toHaveBeenCalledWith(403);
  });

  it('rejects with 403 for a wrong hub.mode', () => {
    const { req, res, sendStatus } = makeReqRes({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': process.env.WHATSAPP_VERIFY_TOKEN as string,
      'hub.challenge': 'challenge-123',
    });

    handleWebhookVerification(req, res);

    expect(sendStatus).toHaveBeenCalledWith(403);
  });
});
