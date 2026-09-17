import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../../../src/memory/db';
import { getOrCreateCustomer, getCustomerByWaId, normalizeWaId, setCustomerLanguage } from '../../../src/memory/customerRepo';

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
});

describe('normalizeWaId', () => {
  it('strips non-digit characters', () => {
    expect(normalizeWaId('+1 (234) 567-8900')).toBe('12345678900');
  });
});

describe('getOrCreateCustomer', () => {
  it('creates a new customer on first contact', () => {
    const customer = getOrCreateCustomer('15551234567', 'Alice', db);
    expect(customer.id).toBeGreaterThan(0);
    expect(customer.wa_id).toBe('15551234567');
    expect(customer.display_name).toBe('Alice');
  });

  it('returns the same customer on repeat contact (identity from WhatsApp number)', () => {
    const first = getOrCreateCustomer('15551234567', 'Alice', db);
    const second = getOrCreateCustomer('15551234567', 'Alice', db);
    expect(second.id).toBe(first.id);
  });

  it('normalizes wa_id formatting differences to the same customer', () => {
    const first = getOrCreateCustomer('+1 555 123 4567', 'Alice', db);
    const second = getOrCreateCustomer('15551234567', 'Alice', db);
    expect(second.id).toBe(first.id);
  });

  it('updates display name when a new one is provided', () => {
    const first = getOrCreateCustomer('15551234567', undefined, db);
    const updated = getOrCreateCustomer('15551234567', 'Bob', db);
    expect(updated.id).toBe(first.id);
    expect(updated.display_name).toBe('Bob');
  });
});

describe('getCustomerByWaId', () => {
  it('returns undefined for unknown numbers', () => {
    expect(getCustomerByWaId('19999999999', db)).toBeUndefined();
  });
});

describe('setCustomerLanguage', () => {
  it('has no language set for a brand-new customer', () => {
    const customer = getOrCreateCustomer('15551234567', 'Alice', db);
    expect(customer.language).toBeNull();
  });

  it('persists the chosen language', () => {
    const customer = getOrCreateCustomer('15551234567', 'Alice', db);
    const updated = setCustomerLanguage(customer.id, 'ar', db);
    expect(updated.language).toBe('ar');
    expect(getCustomerByWaId('15551234567', db)?.language).toBe('ar');
  });

  it('clears the language back to null (used on restart)', () => {
    const customer = getOrCreateCustomer('15551234567', 'Alice', db);
    setCustomerLanguage(customer.id, 'en', db);
    const cleared = setCustomerLanguage(customer.id, null, db);
    expect(cleared.language).toBeNull();
  });
});
