import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w1' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messaging_product: 'whatsapp', contacts: [], messages: [{ id: 'w2' }] }),
}));
vi.mock('../../../src/llm/agentLoop', () => ({ runAgentLoop: vi.fn().mockResolvedValue({ finalText: 'AI reply', generatedMessages: [] }) }));

import { sendTextMessage } from '../../../src/whatsapp/client';
import { getDb } from '../../../src/memory/db';
import { runWithAccount, currentAccountId, LEGACY_ACCOUNT_ID } from '../../../src/accounts/accountContext';
import { createAccount, recordAccountConnected } from '../../../src/accounts/accountRepo';
import { getOrCreateCustomer, getCustomerByWaId, listCustomers, getCustomerById, pauseCustomerAutomation, listPausedCustomers } from '../../../src/memory/customerRepo';
import { getOrCreateActiveConversation, appendMessage, listConversations, getConversationById } from '../../../src/memory/conversationRepo';
import { createOffer, setOfferStatus, listOffers, getOffer, listCustomerVisibleOffers, renderCustomerOffers } from '../../../src/offers/offerRepo';
import { listTemplates, publishTemplate, resolveTemplate, getTemplate } from '../../../src/templates/templateRepo';
import { getBusinessSettings, updateBusinessSettings } from '../../../src/config/businessSettings';
import { getAutomationSettings, updateAutomationSettings } from '../../../src/automation/settingsRepo';
import { createCustomerRequest, listCustomerRequests, getCustomerRequest, getCustomerRequestByReference, countCustomerRequests } from '../../../src/memory/customerRequestRepo';
import { saveDocument, listDocuments, getDocument } from '../../../src/documents/documentStore';
import { buildSystemPrompt } from '../../../src/llm/buildSystemPrompt';
import { enqueueNotification, listOutbox, flushOutbox, registerOutboxSender, NotConnectedError, outboxSummary } from '../../../src/notifications/outbox';
import { changeRequestStatus, businessNotificationJid, handleOperatorCommand } from '../../../src/requests/requestService';
import { processInboundMessage } from '../../../src/pipeline/processInboundMessage';
import { getDashboardSummary } from '../../../src/dashboard/data';
import { listBookingLocks, acquireLock, confirmLock, buildIdempotencyKey, buildSlotKey } from '../../../src/memory/bookingLockRepo';

const KNOWLEDGE = { sections: [], asPromptText: '' };
const SALON = 2;

beforeAll(() => {
  getDb();
  const salon = createAccount({ name: 'Noor Salon', nameAr: 'صالون نور', businessCategory: 'Beauty salon' });
  expect(salon.id).toBe(SALON);
  recordAccountConnected(1, { phoneNumber: '+966558190545', jid: '966558190545:2@s.whatsapp.net', displayName: 'Rowad' });
  recordAccountConnected(SALON, { phoneNumber: '+966511111111', jid: '966511111111:3@s.whatsapp.net', displayName: 'Noor' });
});

describe('account context', () => {
  it('defaults to the legacy account outside any context and switches inside runWithAccount', () => {
    expect(currentAccountId()).toBe(LEGACY_ACCOUNT_ID);
    expect(runWithAccount(SALON, () => currentAccountId())).toBe(SALON);
    expect(currentAccountId()).toBe(LEGACY_ACCOUNT_ID);
  });
});

describe('no cross-account data leakage', () => {
  it('the same phone number is a separate customer in each business; lists and lookups are scoped', () => {
    const cars = getOrCreateCustomer('966500000777', 'Ali (cars)');
    const salon = runWithAccount(SALON, () => getOrCreateCustomer('966500000777', 'Ali (salon)'));
    expect(cars.id).not.toBe(salon.id);
    expect(cars.whatsapp_account_id).toBe(1);
    expect(salon.whatsapp_account_id).toBe(SALON);
    expect(getCustomerByWaId('966500000777')!.display_name).toBe('Ali (cars)');
    expect(runWithAccount(SALON, () => getCustomerByWaId('966500000777'))!.display_name).toBe('Ali (salon)');
    expect(listCustomers({ search: '0777' }).items.map((c) => c.id)).toEqual([cars.id]);
    expect(runWithAccount(SALON, () => listCustomers({ search: '0777' })).items.map((c) => c.id)).toEqual([salon.id]);
    // A primary key from another business is "not found" for the dashboard, but internal callers can opt out of the scope.
    expect(getCustomerById(salon.id)).toBeUndefined();
    expect(getCustomerById(salon.id, undefined, null)!.id).toBe(salon.id);
    expect(runWithAccount(SALON, () => getCustomerById(salon.id))!.id).toBe(salon.id);

    runWithAccount(SALON, () => pauseCustomerAutomation(salon.id, 'test'));
    expect(listPausedCustomers().map((c) => c.id)).not.toContain(salon.id);
    expect(runWithAccount(SALON, () => listPausedCustomers()).map((c) => c.id)).toContain(salon.id);
  });

  it('conversations and bookings follow their customer\'s business', () => {
    const cars = getOrCreateCustomer('966500000778', 'Cars');
    const salon = runWithAccount(SALON, () => getOrCreateCustomer('966500000778', 'Salon'));
    const c1 = getOrCreateActiveConversation(cars.id);
    const c2 = getOrCreateActiveConversation(salon.id); // created from the customer's account, whatever the ambient context
    expect(c1.whatsapp_account_id).toBe(1);
    expect(c2.whatsapp_account_id).toBe(SALON);
    appendMessage(c2.id, { role: 'user', content: 'salon hi' });
    expect(listConversations().items.map((c) => c.id)).not.toContain(c2.id);
    expect(runWithAccount(SALON, () => listConversations()).items.map((c) => c.id)).toContain(c2.id);
    expect(getConversationById(c2.id)).toBeUndefined();
    expect(runWithAccount(SALON, () => getConversationById(c2.id))!.id).toBe(c2.id);

    const lock = acquireLock({ slotKey: buildSlotKey('primary', '2099-05-05T10:00:00.000Z', '2099-05-05T10:30:00.000Z'), idempotencyKey: buildIdempotencyKey(c2.id, '2099-05-05T10:00:00.000Z', '2099-05-05T10:30:00.000Z', 'Cut'), conversationId: c2.id, startISO: '2099-05-05T10:00:00.000Z', endISO: '2099-05-05T10:30:00.000Z' });
    if (lock.acquired) confirmLock(lock.lock.id, 'evt');
    expect(listBookingLocks({ status: 'confirmed' }).items.map((b) => b.conversation_id)).not.toContain(c2.id);
    expect(runWithAccount(SALON, () => listBookingLocks({ status: 'confirmed' })).items.map((b) => b.conversation_id)).toContain(c2.id);
    expect(runWithAccount(SALON, () => getDashboardSummary()).bookings).toBeGreaterThanOrEqual(1);
    expect(getDashboardSummary().conversations).toBeGreaterThanOrEqual(1);
  });

  it('offers: each business sees, renders and edits only its own', () => {
    const salonOffer = runWithAccount(SALON, () => createOffer({ titleAr: 'قص شعر', titleEn: 'Haircut deal' }, 'test'));
    runWithAccount(SALON, () => setOfferStatus(salonOffer.id, 'published', 'test'));
    expect(listOffers().map((o) => o.id)).not.toContain(salonOffer.id);
    expect(getOffer(salonOffer.id)).toBeUndefined(); // cars cannot read the salon's offer by id
    expect(runWithAccount(SALON, () => getOffer(salonOffer.id))!.title_en).toBe('Haircut deal');
    expect(listCustomerVisibleOffers().some((o) => o.id === salonOffer.id)).toBe(false);
    expect(runWithAccount(SALON, () => renderCustomerOffers('en'))).toContain('Haircut deal');
    expect(renderCustomerOffers('en')).not.toContain('Haircut deal');
  });

  it('templates: the salon gets its own set; publishing there never changes the car business\'s live text', () => {
    const cars = getTemplate('main_menu')!.liveEn;
    const salonBefore = runWithAccount(SALON, () => getTemplate('main_menu'))!;
    // A second business starts from the NEUTRAL set — never from Rowad Alfa's wording.
    expect(cars).toContain('Rowad Alfa');
    expect(salonBefore.liveEn).not.toContain('Rowad');
    expect(salonBefore.liveEn).not.toContain('Car Audio');
    expect(salonBefore.liveEn).toContain('{business}');
    runWithAccount(SALON, () => publishTemplate('main_menu', { ar: 'قائمة الصالون', en: 'Salon menu' }, 'test'));
    expect(runWithAccount(SALON, () => resolveTemplate('main_menu', 'en'))).toBe('Salon menu');
    expect(resolveTemplate('main_menu', 'en')).toBe(cars);
    const salonKeys = runWithAccount(SALON, () => listTemplates()).map((t) => t.key);
    expect(salonKeys).not.toContain('car_audio');
    expect(salonKeys).toContain('menu_about');
    expect(listTemplates().map((t) => t.key)).toContain('car_audio');
  });

  it('business profile, automation flags and AI context are per account', () => {
    runWithAccount(SALON, () => updateBusinessSettings({ businessName: 'Noor Salon', businessCategory: 'Beauty salon', descriptionEn: 'Hair and nails in Jeddah' }));
    expect(getBusinessSettings().businessName).not.toBe('Noor Salon');
    expect(getBusinessSettings(SALON).businessName).toBe('Noor Salon');
    runWithAccount(SALON, () => updateAutomationSettings({ aiRepliesEnabled: false }));
    expect(getAutomationSettings().aiRepliesEnabled).toBe(true);
    expect(getAutomationSettings(undefined, SALON).aiRepliesEnabled).toBe(false);

    const salonPrompt = runWithAccount(SALON, () => buildSystemPrompt(KNOWLEDGE, 'en'));
    const carsPrompt = buildSystemPrompt(KNOWLEDGE, 'en');
    expect(salonPrompt).toContain('assistant for Noor Salon');
    expect(salonPrompt).toContain('Hair and nails in Jeddah');
    expect(salonPrompt).toContain('Haircut deal');
    expect(carsPrompt).not.toContain('Noor Salon');
    expect(carsPrompt).not.toContain('Haircut deal');
  });

  it('documents: uploads, lists and id lookups are scoped', () => {
    const doc = runWithAccount(SALON, () => saveDocument({ originalName: 'menu.txt', mimeType: 'text/plain', bytes: Buffer.from('Salon price list'), visibility: 'ai_knowledge' }));
    expect(doc.whatsapp_account_id).toBe(SALON);
    expect(listDocuments().map((d) => d.id)).not.toContain(doc.id);
    expect(getDocument(doc.id)).toBeUndefined();
    expect(runWithAccount(SALON, () => getDocument(doc.id))!.original_name).toBe('menu.txt');
    expect(runWithAccount(SALON, () => buildSystemPrompt(KNOWLEDGE))).toContain('Salon price list');
    expect(buildSystemPrompt(KNOWLEDGE)).not.toContain('Salon price list');
  });

  it('requests and operator commands: references resolve only inside their own business; notifications target that business', async () => {
    const salonCustomer = runWithAccount(SALON, () => getOrCreateCustomer('966500000779', 'Sara'));
    const request = runWithAccount(SALON, () => createCustomerRequest({ customerId: salonCustomer.id, waId: '966500000779', kind: 'appointment', payload: { name: 'Sara', service: 'Cut' } }));
    expect(request.whatsapp_account_id).toBe(SALON);
    expect(listCustomerRequests().map((r) => r.id)).not.toContain(request.id);
    expect(runWithAccount(SALON, () => listCustomerRequests()).map((r) => r.id)).toContain(request.id);
    expect(getCustomerRequest(request.id)).toBeUndefined();
    expect(getCustomerRequestByReference(request.reference)).toBeUndefined();
    expect(runWithAccount(SALON, () => countCustomerRequests('pending'))).toBeGreaterThanOrEqual(1);

    // The car business's phone cannot confirm the salon's request; the salon's phone can.
    expect(handleOperatorCommand({ status: 'confirmed', reference: request.reference }, 'whatsapp:cars', undefined, 1).result).toBeNull();
    const confirmed = handleOperatorCommand({ status: 'confirmed', reference: request.reference }, 'whatsapp:salon', undefined, SALON);
    expect(confirmed.result?.changed).toBe(true);
    expect(getCustomerRequest(request.id, undefined, null)!.status).toBe('confirmed');
    // Staff alerts for the salon go to the salon's own linked number.
    expect(businessNotificationJid(undefined, SALON)).toBe('966511111111@s.whatsapp.net');
    expect(businessNotificationJid()).toBe('966558190545@s.whatsapp.net');
    const rows = listOutbox({ requestId: request.id, accountId: null });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.whatsapp_account_id === SALON)).toBe(true);
    expect(listOutbox({ requestId: request.id })).toEqual([]); // cars sees nothing

    // Dashboard-style status change from the wrong account is "not found"; from the right one it works.
    expect(changeRequestStatus(request.id, 'completed', { type: 'dashboard' }, undefined, 1)).toBeUndefined();
    expect(runWithAccount(SALON, () => changeRequestStatus(request.id, 'completed', { type: 'dashboard' }))!.changed).toBe(true);
  });

  it('outbox delivery routes each row to its own account; one offline account never blocks the other', async () => {
    getDb().prepare('DELETE FROM notification_outbox').run();
    enqueueNotification({ kind: 'operator_result', targetJid: 'a@s.whatsapp.net', body: 'cars', dedupeKey: 'iso:cars', accountId: 1 });
    runWithAccount(SALON, () => enqueueNotification({ kind: 'operator_result', targetJid: 'b@s.whatsapp.net', body: 'salon', dedupeKey: 'iso:salon' }));
    const sent: Array<[string, number]> = [];
    registerOutboxSender(async (jid, _text, accountId) => {
      if (accountId === 1) throw new NotConnectedError(1);
      sent.push([jid, accountId]);
      return `id-${accountId}`;
    });
    expect(await flushOutbox()).toBe(1);
    expect(sent).toEqual([['b@s.whatsapp.net', SALON]]);
    expect(outboxSummary().pending).toBe(1);
    expect(outboxSummary(undefined, SALON).sent).toBe(1);
    registerOutboxSender(null);
  });

  it('an inbound message tagged with account 2 is processed entirely inside account 2 (customer, templates, state)', async () => {
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage({ waId: '966500000780', messageId: 'iso-1', timestamp: Date.now(), type: 'text', text: 'hi', accountId: SALON, channel: 'qr' }, { knowledge: KNOWLEDGE });
    expect(getCustomerByWaId('966500000780')).toBeUndefined();
    const salonCustomer = runWithAccount(SALON, () => getCustomerByWaId('966500000780'));
    expect(salonCustomer?.whatsapp_account_id).toBe(SALON);
    expect(vi.mocked(sendTextMessage).mock.calls.map((c) => c[1])).toEqual([runWithAccount(SALON, () => resolveTemplate('language_selection', 'en'))]);
  });
});
