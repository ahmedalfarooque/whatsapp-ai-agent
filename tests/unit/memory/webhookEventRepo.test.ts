import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import {
  claimWebhookEvent,
  markWebhookEventProcessed,
  markWebhookEventFailed,
  hasWebhookEventBeenProcessed,
} from '../../../src/memory/webhookEventRepo';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('webhook event idempotency', () => {
  it('claims a new message id successfully', () => {
    expect(claimWebhookEvent('wamid.1', 'text from ***1234', db)).toBe(true);
  });

  it('refuses to re-claim an already-seen message id (duplicate delivery protection)', () => {
    expect(claimWebhookEvent('wamid.1', 'text', db)).toBe(true);
    expect(claimWebhookEvent('wamid.1', 'text', db)).toBe(false);
  });

  it('tracks processed state separately from claim state', () => {
    claimWebhookEvent('wamid.2', 'text', db);
    expect(hasWebhookEventBeenProcessed('wamid.2', db)).toBe(false);
    markWebhookEventProcessed('wamid.2', db);
    expect(hasWebhookEventBeenProcessed('wamid.2', db)).toBe(true);
  });

  it('records failure information without throwing', () => {
    claimWebhookEvent('wamid.3', 'text', db);
    expect(() => markWebhookEventFailed('wamid.3', 'boom', db)).not.toThrow();
  });
});
