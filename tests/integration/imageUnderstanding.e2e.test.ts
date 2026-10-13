import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/whatsapp/client', () => ({
  sendTextMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendInteractiveMessage: vi.fn().mockResolvedValue({ messages: [{ id: 'wamid.OUT' }] }),
  sendImageMessage: vi.fn(),
  sendDocumentMessage: vi.fn(),
  markMessageAsRead: vi.fn().mockResolvedValue(undefined),
}));

import { sendTextMessage } from '../../src/whatsapp/client';
import { processInboundMessage } from '../../src/pipeline/processInboundMessage';
import { getDb } from '../../src/memory/db';
import { createAccount } from '../../src/accounts/accountRepo';
import { runWithAccount } from '../../src/accounts/accountContext';
import { getCustomerByWaId, setCustomerMenuState } from '../../src/memory/customerRepo';
import { getOrCreateActiveConversation } from '../../src/memory/conversationRepo';
import { updateAutomationSettings, listReplyActivity } from '../../src/automation/settingsRepo';
import { takeOverCustomer } from '../../src/handoff/handoffRepo';
import { env } from '../../src/config/env';
import type { InboundMessage, InboundMedia } from '../../src/webhook/parseInboundPayload';

/**
 * A customer sends a PICTURE. With the REAL provider client (network stubbed) this proves, end to end through the pipeline:
 *  - the picture's bytes reach the vision model as a data URL (never a path, URL or text description), with the caption;
 *  - the vision report is the ONLY image knowledge the chat model gets, now and for follow-up questions (one analysis per picture);
 *  - uncertainty, readable text and unrelated pictures are passed through as the report states them;
 *  - every failure of the vision step ends in ONE honest reply, never a crash, a duplicate or an invented description;
 *  - accounts stay isolated; guided flows, holds and disabled AI keep pictures unanswered as before.
 * The chat model's wording is mocked, so what is asserted is what the model was GIVEN and TOLD, not the prose it would write.
 */
const mutableEnv = env as unknown as Record<string, unknown>;
const KEY = 'sk-or-v1-imagesimagesimagesimagesimagesimages000000';
const originalMock = mutableEnv.shouldUseMockProviders;
const originalKey = mutableEnv.OPENROUTER_API_KEY;
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const answer = (content: string) => json(200, { choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] });
const CAMRY = `SUBJECT: front three-quarter view of a white mid-size sedan
IDENTIFICATION: Toyota Camry, XV70 generation (approx. 2018-2023)
CONFIDENCE: high
EVIDENCE: Toyota emblem on the grille, "CAMRY" badge on the boot lid, XV70 headlight and grille shape
VISIBLE TEXT: "CAMRY", "TOYOTA"
DETAILS: white, alloy wheels, no visible damage
UNCERTAIN: exact model year and trim
CLARIFYING QUESTION: Which model year and trim is your Camry?`;
const UNSURE = `SUBJECT: rear view of a dark SUV at night
IDENTIFICATION: cannot be determined (Toyota Fortuner or Land Cruiser Prado are possible from the taillight shape)
CONFIDENCE: low
EVIDENCE: taillight outline only; no badge readable
VISIBLE TEXT: none
DETAILS: dark colour, low light, blurred
UNCERTAIN: make, model, year
CLARIFYING QUESTION: Which make, model and year is the car?`;
const LABEL = `SUBJECT: a paint tin label
IDENTIFICATION: Jotun Lady Design, interior wall paint
CONFIDENCE: high
EVIDENCE: Jotun logo and product name printed on the label
VISIBLE TEXT: "JOTUN", "LADY DESIGN", "Colour code 1140 Sand", "Batch 23A77", "10 L"
DETAILS: tin appears new
UNCERTAIN: none
CLARIFYING QUESTION: none`;
const UNRELATED = `SUBJECT: a screenshot of a chat conversation
IDENTIFICATION: cannot be determined (no product or vehicle is shown)
CONFIDENCE: low
EVIDENCE: none
VISIBLE TEXT: "ok see you tomorrow"
DETAILS: phone screenshot
UNCERTAIN: what the customer needs
CLARIFYING QUESTION: What would you like help with?`;
const LAND_CRUISER_KB = { sections: [], asPromptText: 'ACCESSORIES: Land Cruiser 300 roof rack (SAR 1,800), Land Cruiser side steps (SAR 950), universal dash cam (SAR 350), window tinting for any car (from SAR 400).' };
const PAINT_KB = { sections: [], asPromptText: 'PAINT-KB: Jotun Lady Design and Fenomastic interior paints, colour matching service.' };

let fetchMock: ReturnType<typeof vi.fn>;
function provider(...responses: Array<() => Response | Promise<Response>>) {
  let i = 0;
  fetchMock = vi.fn(async () => responses[Math.min(i++, responses.length - 1)]!());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
type Body = { model: string; messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }> };
const bodies = () => fetchMock.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)) as Body);
const visionCalls = () => bodies().filter((b) => b.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')));
const chatCalls = () => bodies().filter((b) => !b.messages.some((m) => Array.isArray(m.content)));
const chatText = (b: Body) => b.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
const sent = () => vi.mocked(sendTextMessage).mock.calls.map((c) => String(c[1]));

let AUTO: number;
let PAINT: number;
let counter = 0;
const media = (overrides: Partial<InboundMedia> = {}): InboundMedia => ({ kind: 'image', mimeType: 'image/jpeg', fileName: '', fileLength: JPEG.length, download: async () => JPEG, ...overrides });
const picture = (accountId: number, waId: string, caption: string | undefined, m: InboundMedia = media()): InboundMessage => ({ waId, messageId: `wamid.img.${accountId}.${++counter}`, timestamp: Date.now(), type: 'image', text: caption, accountId, media: m });
const text = (accountId: number, waId: string, body: string): InboundMessage => ({ waId, messageId: `wamid.txt.${accountId}.${++counter}`, timestamp: Date.now(), type: 'text', text: body, accountId });
const nextWa = () => `96655${String(++counter).padStart(8, '0')}`;
const activity = (accountId: number, waId: string) => runWithAccount(accountId, () => listReplyActivity({ limit: 50 })).filter((a) => a.waId === waId).map((a) => ({ kind: a.kind, detail: a.detail }));
const storedAnalyses = (accountId: number, waId: string) => runWithAccount(accountId, () => {
  const c = getCustomerByWaId(waId)!;
  const conv = getOrCreateActiveConversation(c.id);
  return getDb().prepare("SELECT content FROM conversation_messages WHERE conversation_id = ? AND role = 'tool' AND tool_name = 'image_analysis' ORDER BY id").all(conv.id) as Array<{ content: string }>;
});

beforeAll(() => {
  getDb();
  AUTO = createAccount({ name: 'Image Auto Care' }).id;
  PAINT = createAccount({ name: 'Image Paint Shop' }).id;
});
beforeEach(() => {
  mutableEnv.shouldUseMockProviders = false;
  mutableEnv.OPENROUTER_API_KEY = KEY;
  vi.mocked(sendTextMessage).mockClear();
});
afterEach(() => {
  mutableEnv.shouldUseMockProviders = originalMock;
  mutableEnv.OPENROUTER_API_KEY = originalKey;
  vi.unstubAllGlobals();
});

describe('a picture is analysed from its bytes before the assistant answers', () => {
  it('Toyota Camry photo + accessories question: the vision model gets the bytes, the chat model gets the Camry report (never a Land Cruiser guess), ONE reply', async () => {
    const waId = nextWa();
    provider(() => answer(CAMRY), () => answer('I can see your Toyota Camry. For a Camry we have window tinting and a dash cam; which model year is it so I can check specific accessories?'));
    await processInboundMessage(picture(AUTO, waId, 'What accessories do you have for this car?'), { knowledge: LAND_CRUISER_KB });

    expect(visionCalls()).toHaveLength(1);
    const vision = visionCalls()[0]!;
    const parts = vision.messages.find((m) => Array.isArray(m.content))!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.find((p) => p.type === 'image_url')!.image_url!.url).toBe(`data:image/jpeg;base64,${JPEG.toString('base64')}`);
    expect(parts.find((p) => p.type === 'text')!.text).toContain('What accessories do you have for this car?');

    expect(chatCalls()).toHaveLength(1);
    const chat = chatText(chatCalls()[0]!);
    expect(chat).toContain('[IMAGE ANALYSIS — derived from the actual photo the customer sent');
    expect(chat).toContain('IDENTIFICATION: Toyota Camry');
    expect(chat).toContain('[image] What accessories do you have for this car?');
    expect(chat).toContain('Never recommend vehicle- or model-specific');
    expect(chat).toContain('Identify before you advise');
    expect(chat).toContain('do not switch to a different product or model the business happens to sell');
    expect(chat).toContain('Land Cruiser 300 roof rack'); // the business knowledge is still there; the rules say which car the answer is about
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('Toyota Camry');
    expect(activity(AUTO, waId).find((a) => a.kind === 'ai')?.detail).toMatch(/picture analysed in \d+\.\d s/);

    // a follow-up text question about "this car" reuses the stored report: no second analysis, the report is in the model's context
    provider(() => answer('For your Camry the front bumper protection film is SAR 350.'));
    await processInboundMessage(text(AUTO, waId, 'and for the front bumper?'), { knowledge: LAND_CRUISER_KB });
    expect(visionCalls()).toHaveLength(0);
    expect(chatText(chatCalls()[0]!)).toContain('IDENTIFICATION: Toyota Camry');
    expect(storedAnalyses(AUTO, waId)).toHaveLength(1);
    expect(sent()).toHaveLength(2);
  });

  it('an uncertain identification keeps its clarifying question in front of the model, and a picture with no caption is still looked at', async () => {
    const waId = nextWa();
    provider(() => answer(UNSURE), () => answer('I can see a dark SUV but not the exact model. Which make, model and year is the car?'));
    await processInboundMessage(picture(AUTO, waId, undefined), { knowledge: LAND_CRUISER_KB });
    const chat = chatText(chatCalls()[0]!);
    expect(chat).toContain('CONFIDENCE: low');
    expect(chat).toContain('CLARIFYING QUESTION: Which make, model and year is the car?');
    expect(chat).toContain('ask the report\'s CLARIFYING\n  QUESTION');
    expect(sent()).toEqual(['I can see a dark SUV but not the exact model. Which make, model and year is the car?']);
  });

  it('readable text in a picture (labels, codes, sizes) reaches the model verbatim', async () => {
    const waId = nextWa();
    provider(() => answer(LABEL), () => answer('That is Jotun Lady Design, colour 1140 Sand, 10 L.'));
    await processInboundMessage(picture(PAINT, waId, 'do you have this colour?'), { knowledge: PAINT_KB });
    expect(chatText(chatCalls()[0]!)).toContain('VISIBLE TEXT: "JOTUN", "LADY DESIGN", "Colour code 1140 Sand", "Batch 23A77", "10 L"');
    expect(sent()).toHaveLength(1);
  });

  it('an unrelated or unclear picture is passed through as such — no confident subject is invented', async () => {
    const waId = nextWa();
    provider(() => answer(UNRELATED), () => answer('I can see a screenshot. What would you like help with?'));
    await processInboundMessage(picture(AUTO, waId, undefined), { knowledge: LAND_CRUISER_KB });
    const chat = chatText(chatCalls()[0]!);
    expect(chat).toContain('IDENTIFICATION: cannot be determined');
    expect(chat).toContain('If the picture is unclear or unrelated to this business, say what it shows (if anything) and ask how you can help; do not invent a subject');
    expect(sent()).toHaveLength(1);
  });
});

describe('when the picture cannot be analysed, the customer gets ONE honest reply and nothing is invented', () => {
  const expectHonest = async (waId: string, reason: string) => {
    expect(visionCalls().length).toBeLessThanOrEqual(2);
    const chat = chatCalls();
    expect(chat).toHaveLength(1);
    expect(chatText(chat[0]!)).toContain('[IMAGE NOT ANALYSED');
    expect(chatText(chat[0]!)).toContain('do not describe or guess its content');
    expect(sent()).toHaveLength(1);
    expect(storedAnalyses(AUTO, waId)[0]!.content).toContain('IMAGE NOT ANALYSED');
    expect(activity(AUTO, waId).find((a) => a.kind === 'ai')?.detail).toContain(`picture not analysed (${reason})`);
  };

  it('download failure', async () => {
    const waId = nextWa();
    provider(() => answer('I could not open the picture. Could you tell me the make, model and year, or resend it?'));
    await processInboundMessage(picture(AUTO, waId, 'accessories for this?', media({ download: async () => { throw new Error('media gone'); } })), { knowledge: LAND_CRUISER_KB });
    expect(visionCalls()).toHaveLength(0);
    await expectHonest(waId, 'download_failed');
  });

  it('unsupported media type', async () => {
    const waId = nextWa();
    provider(() => answer('I could not open that file. Could you send it as a photo?'));
    await processInboundMessage(picture(AUTO, waId, 'this one', media({ mimeType: 'image/heic-sequence' })), { knowledge: LAND_CRUISER_KB });
    expect(visionCalls()).toHaveLength(0);
    await expectHonest(waId, 'not_an_image');
  });

  it('vision provider failure (bounded to one retry), then the chat still answers', async () => {
    const waId = nextWa();
    provider(() => json(503, { error: { message: 'overloaded' } }), () => json(503, { error: { message: 'overloaded' } }), () => answer('Sorry, I could not open the picture right now. Which car is it?'));
    await processInboundMessage(picture(AUTO, waId, 'accessories?'), { knowledge: LAND_CRUISER_KB });
    expect(visionCalls()).toHaveLength(2);
    await expectHonest(waId, 'provider_failed');
  });

  it('vision rate limit', async () => {
    const waId = nextWa();
    provider(() => json(429, { error: { message: 'rate limited' } }), () => json(429, { error: { message: 'rate limited' } }), () => answer('The picture could not be opened at the moment. Which model is it?'));
    await processInboundMessage(picture(AUTO, waId, 'fits?'), { knowledge: LAND_CRUISER_KB });
    await expectHonest(waId, 'rate_limited');
  });

  it('vision timeout / dropped connection', async () => {
    const waId = nextWa();
    let n = 0;
    fetchMock = vi.fn(async () => {
      n += 1;
      if (n <= 2) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return answer('I could not open the picture. Please tell me the car model.');
    });
    vi.stubGlobal('fetch', fetchMock);
    await processInboundMessage(picture(AUTO, waId, 'this'), { knowledge: LAND_CRUISER_KB });
    expect(sent()).toHaveLength(1);
    expect(chatText(chatCalls()[0]!)).toContain('[IMAGE NOT ANALYSED');
  });
});

describe('pictures respect the same boundaries as text', () => {
  it('accounts are isolated: the same phone\'s Camry report never appears in another business\'s conversation', async () => {
    const waId = nextWa();
    provider(() => answer(CAMRY), () => answer('Camry noted.'));
    await processInboundMessage(picture(AUTO, waId, 'accessories?'), { knowledge: LAND_CRUISER_KB });
    provider(() => answer('Which colour are you after?'));
    await processInboundMessage(text(PAINT, waId, 'Do you have beige wall paint?'), { knowledge: PAINT_KB });
    const chat = chatText(chatCalls()[0]!);
    expect(chat).not.toContain('Camry');
    expect(chat).not.toContain('[IMAGE ANALYSIS — derived');
    expect(chat).toContain('PAINT-KB');
    expect(storedAnalyses(AUTO, waId)).toHaveLength(1);
  });

  it('a new business answers pictures with the shared rules and the shared vision model: nothing to configure', async () => {
    const fresh = createAccount({ name: 'Fresh Business' }).id;
    const waId = nextWa();
    provider(() => answer(LABEL), () => answer('Got it.'));
    await processInboundMessage(picture(fresh, waId, 'is this yours?'), { knowledge: { sections: [], asPromptText: '' } });
    expect(visionCalls()).toHaveLength(1);
    expect(visionCalls()[0]!.model).toBe(env.OPENROUTER_MODEL); // the fresh business's own chat model sees the picture (no separate vision model needed)
    expect(chatText(chatCalls()[0]!)).toContain('PICTURES THE CUSTOMER SENDS');
    expect(sent()).toHaveLength(1);
  });

  it('inside a guided request, with the AI off, or while staff hold the customer, a picture is stored and NOT answered (and never analysed)', async () => {
    provider(() => answer(CAMRY));
    const inFlow = nextWa();
    await processInboundMessage(text(AUTO, inFlow, 'hi'), { knowledge: LAND_CRUISER_KB });
    runWithAccount(AUTO, () => setCustomerMenuState(getCustomerByWaId(inFlow)!.id, 'QUOTATION_STEP_1', null));
    vi.mocked(sendTextMessage).mockClear();
    await processInboundMessage(picture(AUTO, inFlow, 'photo of my car'), { knowledge: LAND_CRUISER_KB });
    expect(sent()).toEqual([]);
    expect(activity(AUTO, inFlow).some((a) => a.kind === 'suppressed' && a.detail?.includes('image message'))).toBe(true);

    const held = nextWa();
    await processInboundMessage(text(AUTO, held, 'Do you sell roof racks?'), { knowledge: LAND_CRUISER_KB }); // answered by the (mocked) model: one chat call
    runWithAccount(AUTO, () => takeOverCustomer(getCustomerByWaId(held)!.id, { type: 'staff', adminId: 7, canManage: true }));
    vi.mocked(sendTextMessage).mockClear();
    provider(() => answer(CAMRY));
    await processInboundMessage(picture(AUTO, held, 'this one'), { knowledge: LAND_CRUISER_KB });
    expect(sent()).toEqual([]);

    runWithAccount(PAINT, () => updateAutomationSettings({ aiRepliesEnabled: false }, undefined, PAINT));
    try {
      const off = nextWa();
      await processInboundMessage(picture(PAINT, off, 'colour?'), { knowledge: PAINT_KB });
      expect(sent()).toEqual([]);
    } finally {
      runWithAccount(PAINT, () => updateAutomationSettings({ aiRepliesEnabled: true }, undefined, PAINT));
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a file is READ (or honestly reported unreadable) and answered by the AI; a voice note with no audio model configured gets ONE acknowledgement and never reaches the model', async () => {
    provider(() => answer(CAMRY));
    const waId = nextWa();
    // the "PDF" here is not a real PDF: the extractor fails, the model is told the file was NOT read, and still answers the customer
    await processInboundMessage({ waId, messageId: `wamid.doc.${++counter}`, timestamp: Date.now(), type: 'document', text: 'my invoice', accountId: AUTO, media: media({ kind: 'document', mimeType: 'application/pdf' }) }, { knowledge: LAND_CRUISER_KB });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0]![1] as { body: string }).body)).toContain('DOCUMENT NOT READ');
    await processInboundMessage({ waId, messageId: `wamid.voice.${++counter}`, timestamp: Date.now(), type: 'voice', accountId: AUTO }, { knowledge: LAND_CRUISER_KB });
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toMatch(/voice notes, videos or files/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the voice note never reached the model: no audio model is configured
  });
});
