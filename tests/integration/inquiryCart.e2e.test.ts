import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/whatsapp/client')>();
  return { ...real, sendTextMessage: vi.fn(), sendInteractiveMessage: vi.fn(), sendImageMessage: vi.fn(), sendDocumentMessage: vi.fn() };
});
vi.mock('../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn() }));

import { sendTextMessage } from '../../src/whatsapp/client';
import { runAgentLoop } from '../../src/llm/agentLoop';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getCustomerByWaId } from '../../src/memory/customerRepo';
import { getOpenCart, cartItems } from '../../src/cart/cartRepo';

const KNOWLEDGE = { sections: [], asPromptText: '' };
let A: number;
let B: number;
let counter = 0;
const sent: string[] = [];

const newWaId = () => `96567${String(++counter).padStart(7, '0')}`;
async function say(accountId: number, waId: string, text: string): Promise<string[]> {
  sent.length = 0;
  await processInboundMessage({ waId, messageId: `wamid.cart.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text, accountId }, { knowledge: KNOWLEDGE });
  return [...sent];
}
/** A customer standing on the main menu, in English ('2') or Arabic ('1'). */
async function ready(accountId: number, language: 'en' | 'ar' = 'en'): Promise<string> {
  const waId = newWaId();
  await say(accountId, waId, 'hi');
  await say(accountId, waId, language === 'en' ? '2' : '1');
  return waId;
}
const rows = <T>(accountId: number, sql: string, ...args: unknown[]): T[] => runWithAccount(accountId, () => getDb().prepare(sql).all(...args) as T[]);
const customerOf = (accountId: number, waId: string) => runWithAccount(accountId, () => getCustomerByWaId(waId)!);
const requestsOf = (accountId: number, waId: string) =>
  rows<{ reference: string; kind: string; status: string; source: string; cart_id: number | null; payload: string }>(
    accountId, 'SELECT reference, kind, status, source, cart_id, payload FROM customer_requests WHERE customer_id = ? ORDER BY id', customerOf(accountId, waId).id);
const menuState = (accountId: number, waId: string) => customerOf(accountId, waId).menu_state;

beforeAll(() => {
  getDb();
  A = createAccount({ name: 'Cart Shop A' }).id;
  B = createAccount({ name: 'Cart Shop B' }).id;
});
beforeEach(() => {
  sent.length = 0;
  vi.mocked(sendTextMessage).mockReset().mockImplementation(async (_to, body) => { sent.push(String(body)); return { messaging_product: 'whatsapp', contacts: [], messages: [{ id: 't' }] }; });
  vi.mocked(runAgentLoop).mockReset().mockResolvedValue({ finalText: 'AI answer', generatedMessages: [{ role: 'assistant', content: 'AI answer' }] });
});

describe('the Inquiry Cart is in the main menu of every business', () => {
  it('a new business (8 items) offers it as option 9, in English and in Arabic, beside the unchanged "0" change-language line', async () => {
    const en = newWaId();
    await say(A, en, 'hi');
    const [menuEn] = await say(A, en, '2');
    expect(menuEn).toContain('9️⃣ 🛒 Inquiry Cart');
    expect(menuEn).toContain('0️⃣ 🌐 Change language');
    expect(menuEn!.match(/Inquiry Cart/g)).toHaveLength(1);
    const ar = newWaId();
    await say(A, ar, 'hi');
    const [menuAr] = await say(A, ar, '1');
    expect(menuAr).toContain('9️⃣ 🛒 سلة الاستفسارات');
    expect(menuAr).toContain('0️⃣ 🌐 تغيير اللغة');
  });

  it('the original business (nine fixed options) offers it as option 10', async () => {
    const waId = newWaId();
    await say(1, waId, 'hi');
    const [menu] = await say(1, waId, '2');
    expect(menu).toContain('🔟 🛒 Inquiry Cart');
    const out = await say(1, waId, '10');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Inquiry Cart');
    expect(menuState(1, waId)).toBe('CART_MENU');
  });

  it('the old Prices & Offers option 5 opens the same real cart', async () => {
    const waId = await ready(1);
    await say(1, waId, '5'); // Prices & Offers sub-menu
    const out = await say(1, waId, '5');
    expect(out[0]).toContain('Inquiry Cart');
    expect(menuState(1, waId)).toBe('CART_MENU');
  });

  it('0 still changes the language on the main menu and still returns to the main menu from the cart', async () => {
    const waId = await ready(A);
    const lang = await say(A, waId, '0');
    expect(lang[0]).toMatch(/language|اللغة/i);
    await say(A, waId, '1'); // pick Arabic again? '1' = Arabic in the language prompt
    const waId2 = await ready(A);
    await say(A, waId2, '9');
    expect(menuState(A, waId2)).toBe('CART_MENU');
    const back = await say(A, waId2, '0');
    expect(back[0]).toContain('Welcome');
    expect(menuState(A, waId2)).toBe('MAIN_MENU');
  });
});

describe('building and submitting a cart', () => {
  it('add with quantity, add without, review, submit: ONE quotation request that keeps the items; the cart closes', async () => {
    const waId = await ready(A);
    const open = await say(A, waId, '9');
    expect(open[0]).toContain('Your cart is empty.');

    expect((await say(A, waId, '1'))[0]).toContain('What would you like to ask about?');
    expect((await say(A, waId, 'Front bumper protection film'))[0]).toContain('How many');
    const added = await say(A, waId, '3');
    expect(added[0]).toContain('Added to your inquiry cart');
    expect(added[1]).toContain('1. Front bumper protection film — Qty: 3');

    await say(A, waId, '1');
    await say(A, waId, 'Window tint, any shade');
    const second = await say(A, waId, 'skip');
    expect(second[1]).toContain('2. Window tint, any shade');
    expect(second[1]).not.toContain('2. Window tint, any shade — Qty');

    const review = await say(A, waId, '3');
    expect(review[0]).toContain('Review your inquiry');
    expect(runWithAccount(A, () => cartItems(getOpenCart(customerOf(A, waId).id)!.id))).toHaveLength(2);

    const done = await say(A, waId, '1');
    expect(done).toHaveLength(1);
    const reference = /INQ-\d{4}-\d{4}/.exec(done[0]!)?.[0];
    expect(reference).toBeTruthy();
    expect(done[0]).toContain('1. Front bumper protection film — Qty: 3');
    expect(menuState(A, waId)).toBe('MAIN_MENU');

    const requests = requestsOf(A, waId);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reference, kind: 'quotation', status: 'pending', source: 'cart' });
    expect(requests[0]!.cart_id).toBeGreaterThan(0);
    expect(runWithAccount(A, () => getOpenCart(customerOf(A, waId).id))).toBeUndefined();
    // the cart did not reach the AI and did not make a second request
    expect(vi.mocked(runAgentLoop)).not.toHaveBeenCalled();
  });

  it('removing an item renumbers the rest; a bad number is refused without losing anything', async () => {
    const waId = await ready(A);
    await say(A, waId, '9');
    for (const item of ['Item one', 'Item two', 'Item three']) {
      await say(A, waId, '1');
      await say(A, waId, item);
      await say(A, waId, 'skip');
    }
    expect((await say(A, waId, '2'))[0]).toContain('Send the number of the item to remove');
    expect((await say(A, waId, '7'))[0]).toContain('did not understand');
    const removed = await say(A, waId, '2');
    expect(removed[0]).toContain('Removed from your inquiry cart');
    expect(removed[1]).toContain('1. Item one');
    expect(removed[1]).toContain('2. Item three');
    expect(removed[1]).not.toContain('Item two');
  });

  it('an invalid quantity is asked again; the pending item survives', async () => {
    const waId = await ready(A);
    await say(A, waId, '9');
    await say(A, waId, '1');
    await say(A, waId, 'Wheel cleaner');
    expect((await say(A, waId, 'lots'))[0]).toContain('did not understand');
    expect((await say(A, waId, '0.5'))[0]).toContain('did not understand');
    expect((await say(A, waId, '-4'))[0]).toContain('did not understand');
    expect((await say(A, waId, '2'))[1]).toContain('1. Wheel cleaner — Qty: 2');
  });

  it('an empty cart is never submitted: review asks for a general inquiry, whose single message becomes the request', async () => {
    const waId = await ready(A);
    await say(A, waId, '9');
    const prompt = await say(A, waId, '3');
    expect(prompt[0]).toContain('Your cart is empty. Write your inquiry');
    expect(requestsOf(A, waId)).toHaveLength(0);
    const done = await say(A, waId, 'Do you supply fleet discounts?');
    expect(done[0]).toMatch(/INQ-\d{4}-\d{4}/);
    const [request] = requestsOf(A, waId);
    expect(JSON.parse(request!.payload)).toMatchObject({ service: 'General inquiry' });
    expect(requestsOf(A, waId)).toHaveLength(1);
  });

  it('the cart speaks Arabic to an Arabic customer', async () => {
    const waId = await ready(A, 'ar');
    const open = await say(A, waId, '9');
    expect(open[0]).toContain('السلة فارغة');
    await say(A, waId, '1');
    await say(A, waId, 'حماية الصدام');
    const added = await say(A, waId, '٢'); // Arabic-Indic digit
    expect(added[0]).toContain('تمت إضافة');
    expect(added[1]).toContain('1. حماية الصدام — الكمية: 2');
    await say(A, waId, '3');
    const done = await say(A, waId, '1');
    expect(done[0]).toContain('الرقم المرجعي');
  });

  it('free text at a numbered cart step still reaches the AI; words typed while adding an item do not', async () => {
    const waId = await ready(A);
    await say(A, waId, '9');
    expect((await say(A, waId, 'what is your best price?'))[0]).toBe('AI answer');
    await say(A, waId, '1');
    vi.mocked(runAgentLoop).mockClear();
    await say(A, waId, 'what is your best price?'); // consumed as the item description
    expect(vi.mocked(runAgentLoop)).not.toHaveBeenCalled();
  });

  it('a customer cannot hold two open carts, and each business and customer has its own', async () => {
    const one = await ready(A);
    const two = await ready(A);
    const other = await ready(B);
    for (const w of [one, two]) { await say(A, w, '9'); await say(A, w, '1'); await say(A, w, `Item of ${w}`); await say(A, w, 'skip'); }
    await say(B, other, '9'); await say(B, other, '1'); await say(B, other, 'Item in B'); await say(B, other, 'skip');
    expect(rows<{ n: number }>(A, `SELECT COUNT(*) AS n FROM inquiry_carts WHERE status = 'open' AND customer_id = ?`, customerOf(A, one).id)[0]!.n).toBe(1);
    const aItems = runWithAccount(A, () => cartItems(getOpenCart(customerOf(A, one).id)!.id));
    expect(aItems.map((i) => i.description)).toEqual([`Item of ${one}`]);
    expect(rows<{ whatsapp_account_id: number }>(B, 'SELECT whatsapp_account_id FROM inquiry_cart_items WHERE description = ?', 'Item in B')).toEqual([{ whatsapp_account_id: B }]);
  });
});

describe('checking the status of an inquiry from WhatsApp', () => {
  async function submitted(accountId: number): Promise<{ waId: string; reference: string }> {
    const waId = await ready(accountId);
    const n = accountId === 1 ? '10' : '9';
    await say(accountId, waId, n); await say(accountId, waId, '1'); await say(accountId, waId, 'Status test item'); await say(accountId, waId, 'skip'); await say(accountId, waId, '3');
    const done = await say(accountId, waId, '1');
    return { waId, reference: /INQ-\d{4}-\d{4}/.exec(done[0]!)![0] };
  }

  it('lists the customer\'s own requests and answers a reference with its real status; nothing internal appears', async () => {
    const { waId, reference } = await submitted(A);
    await say(A, waId, '9');
    const list = await say(A, waId, '4');
    expect(list[0]).toContain(reference);
    expect(list[0]).toContain('Quotation — Pending');
    const detail = await say(A, waId, reference.toLowerCase());
    expect(detail[0]).toContain(reference);
    expect(detail[0]).toContain('Status: Pending');
    expect(detail[0]).toContain('Status test item');
    expect(detail[0]).not.toMatch(/internal|admin|note/i);
  });

  it('another customer, and another business, get "not found" for the same reference — the same answer as for a made-up one', async () => {
    const { reference } = await submitted(A);
    const { waId: stranger } = await submitted(A); // another customer of the same business, with a request of their own
    await say(A, stranger, '9');
    await say(A, stranger, '4');
    const ownerless = await say(A, stranger, reference);
    expect(ownerless[0]).toContain('could not find');
    const madeUp = await say(A, stranger, 'INQ-2026-0001');
    expect(madeUp[0]).toBe(ownerless[0]);
    const { waId: elsewhere } = await submitted(B); // has requests of its own in B, so the status list is open
    await say(B, elsewhere, '9');
    await say(B, elsewhere, '4');
    expect((await say(B, elsewhere, reference))[0]).toContain('could not find');
  });

  it('a customer with no requests is told so, not shown an empty list', async () => {
    const waId = await ready(A);
    await say(A, waId, '9');
    expect((await say(A, waId, '4'))[0]).toContain('no inquiries or quotations on record');
  });
});
