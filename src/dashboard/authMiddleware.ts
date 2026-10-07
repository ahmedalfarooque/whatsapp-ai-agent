import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { verifySessionToken } from './auth';

export const SESSION_COOKIE_NAME = 'dashboard_session';

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function readSessionToken(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}

export function setSessionCookie(res: Response, token: string, expiresAt: string): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (env.isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (env.isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

declare module 'express-serve-static-core' {
  interface Request {
    adminUserId?: number;
    /** The WhatsApp account (business) the request operates on — set by the account middleware in router.ts. */
    accountId?: number;
  }
}

/** Gates every non-auth dashboard route. Replaces the old env.isProduction-only
 * gate — the dashboard is now reachable in every environment, but only with a
 * valid, non-expired session. */
export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readSessionToken(req);
  const session = token ? verifySessionToken(token) : null;
  if (!session) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  req.adminUserId = session.adminUserId;
  next();
}
