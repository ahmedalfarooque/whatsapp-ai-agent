import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { verifySignatureMiddleware } from '../../../src/webhook/verifySignature';

const APP_SECRET = process.env.META_APP_SECRET as string;

function sign(body: Buffer): string {
  return `sha256=${crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex')}`;
}

function makeReqRes(rawBody: Buffer, signature?: string) {
  const req = {
    header: (name: string) => (name.toLowerCase() === 'x-hub-signature-256' ? signature : undefined),
    rawBody,
  } as unknown as Request;

  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status } as unknown as Response;
  const next = vi.fn();

  return { req, res, next, status, json };
}

describe('verifySignatureMiddleware', () => {
  it('calls next() for a valid signature', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const { req, res, next } = makeReqRes(body, sign(body));

    verifySignatureMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });

  it('rejects with 401 when the body has been tampered with', () => {
    const originalBody = Buffer.from(JSON.stringify({ hello: 'world' }));
    const signature = sign(originalBody);
    const tamperedBody = Buffer.from(JSON.stringify({ hello: 'WORLD_TAMPERED' }));
    const { req, res, next, status } = makeReqRes(tamperedBody, signature);

    verifySignatureMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects with 401 when the signature header is missing', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const { req, res, next, status } = makeReqRes(body, undefined);

    verifySignatureMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });

  it('rejects with 401 for a well-formed but incorrect signature', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const { req, res, next, status } = makeReqRes(body, 'sha256=' + '0'.repeat(64));

    verifySignatureMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(401);
  });
});
