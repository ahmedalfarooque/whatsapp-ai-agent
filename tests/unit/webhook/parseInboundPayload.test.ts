import { describe, it, expect } from 'vitest';
import { parseInboundPayload } from '../../../src/webhook/parseInboundPayload';

function makePayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              contacts: [{ profile: { name: 'Alice' }, wa_id: '15551234567' }],
              messages: [
                {
                  from: '15551234567',
                  id: 'wamid.HASH',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'Hello there' },
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

describe('parseInboundPayload', () => {
  it('extracts a normalized text message with contact name', () => {
    const result = parseInboundPayload(makePayload());
    expect(result).toEqual([
      {
        waId: '15551234567',
        messageId: 'wamid.HASH',
        timestamp: 1700000000000,
        type: 'text',
        text: 'Hello there',
        contactName: 'Alice',
      },
    ]);
  });

  it('ignores non-text message types gracefully (no text field extracted)', () => {
    const payload = makePayload({
      messages: [
        { from: '15551234567', id: 'wamid.IMG', timestamp: '1700000000', type: 'image' },
      ],
    });
    const result = parseInboundPayload(payload);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image');
    expect(result[0].text).toBeUndefined();
  });

  it('returns an empty array for status-only changes (no messages)', () => {
    const payload = makePayload({ messages: undefined, statuses: [{ id: 'wamid.HASH', status: 'delivered' }] });
    expect(parseInboundPayload(payload)).toEqual([]);
  });

  it('returns an empty array for a malformed/unexpected body', () => {
    expect(parseInboundPayload({ object: 'page' })).toEqual([]);
    expect(parseInboundPayload(null)).toEqual([]);
    expect(parseInboundPayload(undefined)).toEqual([]);
    expect(parseInboundPayload('not an object')).toEqual([]);
  });

  it('extracts a button_reply interactive message with its stable ID', () => {
    const payload = makePayload({
      messages: [
        {
          from: '15551234567',
          id: 'wamid.BTN',
          timestamp: '1700000000',
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'lang_en', title: 'English' } },
        },
      ],
    });
    const result = parseInboundPayload(payload);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('interactive');
    expect(result[0].interactiveId).toBe('lang_en');
    expect(result[0].text).toBeUndefined();
  });

  it('extracts a list_reply interactive message with its stable ID', () => {
    const payload = makePayload({
      messages: [
        {
          from: '15551234567',
          id: 'wamid.LIST',
          timestamp: '1700000000',
          type: 'interactive',
          interactive: { type: 'list_reply', list_reply: { id: 'menu_car_audio', title: 'Car Audio' } },
        },
      ],
    });
    const result = parseInboundPayload(payload);
    expect(result[0].interactiveId).toBe('menu_car_audio');
  });

  it('handles multiple messages across multiple entries/changes', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        makePayload().entry[0],
        {
          id: 'entry-2',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                messages: [
                  { from: '15559999999', id: 'wamid.OTHER', timestamp: '1700000100', type: 'text', text: { body: 'Second' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const result = parseInboundPayload(payload);
    expect(result).toHaveLength(2);
    expect(result[1].waId).toBe('15559999999');
  });
});
