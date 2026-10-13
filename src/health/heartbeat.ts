/**
 * Worker heartbeat for /readiness: the last times the inbound listener received and finished a customer message, per account,
 * so "the service is up but nothing is being processed" is visible without reading logs. In-memory, process-wide, no customer data.
 */
const lastInbound = new Map<number, number>();
const lastProcessed = new Map<number, number>();
let bootedAt = Date.now();

export function noteInbound(accountId: number, at: number = Date.now()): void {
  lastInbound.set(accountId, at);
}
export function noteProcessed(accountId: number, at: number = Date.now()): void {
  lastProcessed.set(accountId, at);
}

export interface Heartbeat {
  bootedAt: string;
  uptimeSeconds: number;
  /** Newest inbound/processed times across every account (null until the first message after boot). */
  lastInboundAt: string | null;
  lastProcessedAt: string | null;
  perAccount: Array<{ accountId: number; lastInboundAt: string | null; lastProcessedAt: string | null }>;
}

export function heartbeat(now: number = Date.now()): Heartbeat {
  const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : null);
  const ids = new Set([...lastInbound.keys(), ...lastProcessed.keys()]);
  return {
    bootedAt: new Date(bootedAt).toISOString(),
    uptimeSeconds: Math.floor((now - bootedAt) / 1000),
    lastInboundAt: iso(Math.max(0, ...lastInbound.values()) || undefined),
    lastProcessedAt: iso(Math.max(0, ...lastProcessed.values()) || undefined),
    perAccount: [...ids].sort((a, b) => a - b).map((accountId) => ({ accountId, lastInboundAt: iso(lastInbound.get(accountId)), lastProcessedAt: iso(lastProcessed.get(accountId)) })),
  };
}

/** Test helper. */
export function resetHeartbeatForTests(now: number = Date.now()): void {
  lastInbound.clear();
  lastProcessed.clear();
  bootedAt = now;
}
