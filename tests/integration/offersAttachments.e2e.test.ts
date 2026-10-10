import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { customerOfferMedia } from '../../src/offers/offerMedia';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('dashboard-uploaded-image')]);
const PDF = Buffer.from('%PDF-1.4 dashboard uploaded pdf');
const ACCOUNT_HEADER = 'X-Whatsapp-Account';

describe('Offers page → upload → offer → what the customer receives, through the real dashboard routes', () => {
  const app = createApp();
  const agent = request.agent(app);
  let second: number;

  const upload = (accountId: number, name: string, type: string, bytes: Buffer, visibility = 'customer') =>
    agent
      .post('/api/dashboard/documents')
      .set(ACCOUNT_HEADER, String(accountId))
      .set('Content-Type', type)
      .set('X-File-Name', encodeURIComponent(name))
      .set('X-Visibility', visibility)
      .set('X-Title', encodeURIComponent(name))
      .send(bytes);
  const offerBody = (extra: Record<string, unknown> = {}) => ({ titleAr: 'عرض', titleEn: 'Dashboard offer', descriptionEn: 'Details', ...extra });

  beforeAll(async () => {
    expect((await agent.post('/api/dashboard/auth/setup').send({ username: 'offers-admin', password: 'a-very-long-test-password-123' })).status).toBe(201);
    getDb();
    second = createAccount({ name: 'Second Offers Shop' }).id;
  });

  it('an administrator uploads a picture and a PDF, attaches them, publishes — and the business\'s customers will receive both', async () => {
    const image = await upload(1, 'summer.png', 'image/png', PNG);
    const pdf = await upload(1, 'terms.pdf', 'application/pdf', PDF);
    expect(image.status).toBe(201);
    expect(pdf.status).toBe(201);

    const created = await agent.post('/api/dashboard/offers').set(ACCOUNT_HEADER, '1').send(offerBody({ imageDocumentId: image.body.id, documentId: pdf.body.id }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ image_document_id: image.body.id, document_id: pdf.body.id });
    expect((await agent.post(`/api/dashboard/offers/${created.body.id}/publish`).set(ACCOUNT_HEADER, '1')).status).toBe(200);

    const toSend = runWithAccount(1, () => customerOfferMedia('en'));
    expect(toSend.skipped).toEqual([]);
    expect(toSend.items.map((i) => [i.kind, i.mimeType, i.fileName])).toEqual([
      ['image', 'image/png', 'Dashboard offer.png'],
      ['document', 'application/pdf', 'Dashboard offer.pdf'],
    ]);
  });

  it('another business cannot attach that file to its own offer by typing its id', async () => {
    const mine = await upload(1, 'mine.png', 'image/png', PNG);
    const attempt = await agent.post('/api/dashboard/offers').set(ACCOUNT_HEADER, String(second)).send(offerBody({ imageDocumentId: mine.body.id }));
    expect(attempt.status).toBe(400);
    expect(attempt.body).toMatchObject({ error: 'validation_failed' });
    expect(attempt.body.fields.imageDocumentId).toMatch(/not found among this business/i);
    // A plain-language message only: no drive letter, no folder path, no stored file name.
    expect(JSON.stringify(attempt.body)).not.toMatch(/[A-Za-z]:\\|\/uploads\/|\\uploads\\|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('another business cannot preview or download that file either', async () => {
    const mine = await upload(1, 'private.png', 'image/png', PNG);
    expect((await agent.get(`/api/dashboard/documents/${mine.body.id}/file`).set(ACCOUNT_HEADER, '1')).status).toBe(200);
    expect((await agent.get(`/api/dashboard/documents/${mine.body.id}/file`).set(ACCOUNT_HEADER, String(second))).status).toBe(404);
  });

  it('a file uploaded as internal cannot be attached to a customer offer, and the form is told why', async () => {
    const internal = await upload(1, 'internal.png', 'image/png', PNG, 'internal');
    const attempt = await agent.post('/api/dashboard/offers').set(ACCOUNT_HEADER, '1').send(offerBody({ imageDocumentId: internal.body.id }));
    expect(attempt.status).toBe(400);
    expect(attempt.body.fields.imageDocumentId).toMatch(/internal/i);
  });

  it('a PDF cannot be put in the image slot, and a text-only offer still saves', async () => {
    const pdf = await upload(1, 'wrongslot.pdf', 'application/pdf', PDF);
    const wrong = await agent.post('/api/dashboard/offers').set(ACCOUNT_HEADER, '1').send(offerBody({ imageDocumentId: pdf.body.id }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.fields.imageDocumentId).toMatch(/picture/i);
    expect((await agent.post('/api/dashboard/offers').set(ACCOUNT_HEADER, '1').send(offerBody())).status).toBe(201);
  });

  it('the second business can use its own uploads, and they reach only its own customers', async () => {
    const own = await upload(second, 'own.png', 'image/png', PNG);
    const created = await agent.post('/api/dashboard/offers').set(ACCOUNT_HEADER, String(second)).send(offerBody({ titleEn: 'Second only', imageDocumentId: own.body.id }));
    expect(created.status).toBe(201);
    await agent.post(`/api/dashboard/offers/${created.body.id}/publish`).set(ACCOUNT_HEADER, String(second));
    const secondItems = runWithAccount(second, () => customerOfferMedia('en')).items;
    expect(secondItems.map((i) => i.title)).toEqual(['Second only']);
    expect(runWithAccount(1, () => customerOfferMedia('en')).items.map((i) => i.title)).not.toContain('Second only');
  });
});
