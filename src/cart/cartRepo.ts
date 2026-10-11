import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { createCustomerRequest, type CustomerRequest } from '../memory/customerRequestRepo';

/**
 * The customer's Inquiry Cart: a working list of what they want to ask about. It never holds a price: it is not a purchase. Submitting it
 * creates ONE ordinary quotation request (customer_requests, kind 'quotation') and closes the cart, so staff, reports, notifications and
 * status checks all keep using the single canonical request record. Every query is scoped to the current business.
 */

export const MAX_CART_ITEMS = 20;
export const MAX_ITEM_CHARS = 300;
export const MAX_QUANTITY = 100_000;

export interface CartItem {
  id: number;
  cart_id: number;
  position: number;
  description: string;
  quantity: number | null;
  notes: string | null;
  source: 'customer' | 'general';
  removed_at: string | null;
}

export interface Cart {
  id: number;
  whatsapp_account_id: number;
  customer_id: number;
  status: 'open' | 'submitted' | 'cancelled';
  request_id: number | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

export class CartFullError extends Error {}

/** Collapses whitespace, strips control characters and bounds the length: customer text is data, never markup or a command. */
export function cleanItemText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS);
}

/** "3", "٣", "x3" → 3. Anything else (0, negative, decimals, text, too large) → null. */
export function parseQuantity(value: string): number | null {
  const digits = value.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim().replace(/^[x×]\s*/i, '');
  if (!/^\d{1,6}$/.test(digits)) return null;
  const n = Number(digits);
  return n >= 1 && n <= MAX_QUANTITY ? n : null;
}

export function getOpenCart(customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): Cart | undefined {
  return db.prepare(`SELECT * FROM inquiry_carts WHERE customer_id = ? AND whatsapp_account_id = ? AND status = 'open'`).get(customerId, accountId) as Cart | undefined;
}

export function getOrCreateOpenCart(customerId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): Cart {
  const existing = getOpenCart(customerId, db, accountId);
  if (existing) return existing;
  try {
    db.prepare(`INSERT INTO inquiry_carts (whatsapp_account_id, customer_id) VALUES (?, ?)`).run(accountId, customerId);
  } catch (error) {
    if (!String((error as Error).message).includes('UNIQUE')) throw error; // a concurrent message created it first
  }
  return getOpenCart(customerId, db, accountId) as Cart;
}

export function cartItems(cartId: number, db: Database.Database = getDb()): CartItem[] {
  return db.prepare('SELECT * FROM inquiry_cart_items WHERE cart_id = ? AND removed_at IS NULL ORDER BY position ASC').all(cartId) as CartItem[];
}

export function addCartItem(
  cartId: number,
  input: { description: string; quantity?: number | null; notes?: string | null; source?: 'customer' | 'general' },
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): CartItem {
  const description = cleanItemText(input.description);
  if (!description) throw new Error('An item needs a description');
  const tx = db.transaction(() => {
    const count = (db.prepare('SELECT COUNT(*) AS n FROM inquiry_cart_items WHERE cart_id = ? AND removed_at IS NULL').get(cartId) as { n: number }).n;
    if (count >= MAX_CART_ITEMS) throw new CartFullError('cart is full');
    const result = db
      .prepare(`INSERT INTO inquiry_cart_items (cart_id, whatsapp_account_id, position, description, quantity, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(cartId, accountId, count + 1, description, input.quantity ?? null, input.notes ? cleanItemText(input.notes) : null, input.source ?? 'customer');
    db.prepare(`UPDATE inquiry_carts SET updated_at = datetime('now') WHERE id = ?`).run(cartId);
    return db.prepare('SELECT * FROM inquiry_cart_items WHERE id = ?').get(result.lastInsertRowid) as CartItem;
  });
  return tx();
}

/** Removes (marks removed; never deletes) the item at a 1-based position of THIS cart and renumbers the rest. Returns false when there is no such position. */
export function removeCartItem(cartId: number, position: number, db: Database.Database = getDb()): boolean {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT id FROM inquiry_cart_items WHERE cart_id = ? AND position = ? AND removed_at IS NULL').get(cartId, position) as { id: number } | undefined;
    if (!row) return false;
    db.prepare("UPDATE inquiry_cart_items SET removed_at = datetime('now') WHERE id = ?").run(row.id);
    db.prepare('UPDATE inquiry_cart_items SET position = position - 1 WHERE cart_id = ? AND position > ? AND removed_at IS NULL').run(cartId, position);
    db.prepare(`UPDATE inquiry_carts SET updated_at = datetime('now') WHERE id = ?`).run(cartId);
    return true;
  });
  return tx();
}

/** The cart as the customer and staff read it: "1. Item - qty 3". Quantity is shown only when the customer gave one. */
export function renderCartLines(items: CartItem[], language: 'ar' | 'en'): string {
  const qty = language === 'ar' ? 'الكمية' : 'Qty';
  return items.map((i) => `${i.position}. ${i.description}${i.quantity ? ` — ${qty}: ${i.quantity}` : ''}`).join('\n');
}

export interface SubmitResult {
  request: CustomerRequest;
  cart: Cart;
}

/**
 * Turns the open cart into ONE quotation request, atomically: the request, the link back to the cart and the closing of the cart
 * happen together or not at all, and a cart is submitted once (it is closed by the same transaction). An EMPTY cart cannot be submitted.
 * A general inquiry (a business with no products, or a customer who typed one message) is a cart with one 'general' item.
 */
export function submitCart(
  customerId: number,
  waId: string,
  customerName: string,
  language: 'ar' | 'en',
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): SubmitResult | null {
  const tx = db.transaction((): SubmitResult | null => {
    const cart = getOpenCart(customerId, db, accountId);
    if (!cart) return null;
    const items = cartItems(cart.id, db);
    if (items.length === 0) return null;
    const general = items.length === 1 && items[0]!.source === 'general';
    const request = createCustomerRequest(
      {
        customerId,
        waId,
        kind: 'quotation',
        accountId,
        payload: {
          name: customerName || '',
          service: general ? (language === 'ar' ? 'استفسار عام' : 'General inquiry') : items.map((i) => i.description).join(' | ').slice(0, 200),
          details: renderCartLines(items, language),
        },
      },
      db,
    );
    db.prepare(`UPDATE customer_requests SET cart_id = ?, source = 'cart' WHERE id = ?`).run(cart.id, request.id);
    db.prepare(`UPDATE inquiry_carts SET status = 'submitted', request_id = ?, submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(request.id, cart.id);
    return { request: { ...request }, cart: { ...cart, status: 'submitted', request_id: request.id } };
  });
  return tx();
}

/** Staff view: the items of a submitted cart, by the request they became. Scoped to the business. */
export function cartItemsForRequest(requestId: number, db: Database.Database = getDb(), accountId: number = currentAccountId()): CartItem[] {
  const cart = db.prepare('SELECT id FROM inquiry_carts WHERE request_id = ? AND whatsapp_account_id = ?').get(requestId, accountId) as { id: number } | undefined;
  return cart ? cartItems(cart.id, db) : [];
}
