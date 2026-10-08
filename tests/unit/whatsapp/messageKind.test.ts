import { describe, it, expect } from 'vitest';
import { classifyMessage, isAnswerableKind } from '../../../src/whatsapp/messageKind';

const m = (message: Record<string, unknown> | null | undefined) => classifyMessage({ message });

describe('classifyMessage — only plain text is answerable', () => {
  it('reads plain and extended text, and the text of a tapped button or list row', () => {
    expect(m({ conversation: '  Hello  ' })).toEqual({ kind: 'text', text: 'Hello', caption: '' });
    expect(m({ extendedTextMessage: { text: 'Do you have exterior paint?' } }).kind).toBe('text');
    expect(m({ buttonsResponseMessage: { selectedDisplayText: 'English' } })).toMatchObject({ kind: 'text', text: 'English' });
    expect(m({ listResponseMessage: { title: 'Prices' } })).toMatchObject({ kind: 'text', text: 'Prices' });
  });

  it('tells a voice note from other audio', () => {
    expect(m({ audioMessage: { ptt: true, seconds: 4 } }).kind).toBe('voice');
    expect(m({ audioMessage: { ptt: false } }).kind).toBe('audio');
    expect(m({ audioMessage: {} }).kind).toBe('audio');
  });

  it('classifies images, video (including round video notes and GIFs), documents, stickers, locations and contacts', () => {
    expect(m({ imageMessage: { mimetype: 'image/jpeg' } }).kind).toBe('image');
    expect(m({ videoMessage: { gifPlayback: true } }).kind).toBe('video');
    expect(m({ ptvMessage: {} }).kind).toBe('video');
    expect(m({ documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf' } }).kind).toBe('document');
    expect(m({ stickerMessage: {} }).kind).toBe('sticker');
    expect(m({ locationMessage: { degreesLatitude: 21.5 } }).kind).toBe('location');
    expect(m({ liveLocationMessage: {} }).kind).toBe('location');
    expect(m({ contactMessage: { displayName: 'Ali' } }).kind).toBe('contact');
    expect(m({ contactsArrayMessage: { contacts: [] } }).kind).toBe('contact');
  });

  it('keeps a media caption as a caption, never as the customer text', () => {
    expect(m({ imageMessage: { caption: 'How much for this?' } })).toEqual({ kind: 'image', text: '', caption: 'How much for this?' });
    expect(m({ videoMessage: { caption: 'look' } })).toMatchObject({ kind: 'video', text: '', caption: 'look' });
    expect(m({ documentMessage: { caption: 'my invoice' } })).toMatchObject({ kind: 'document', text: '', caption: 'my invoice' });
  });

  it('sees through disappearing, view-once and document-with-caption wrappers', () => {
    expect(m({ ephemeralMessage: { message: { conversation: 'hi' } } })).toMatchObject({ kind: 'text', text: 'hi' });
    expect(m({ ephemeralMessage: { message: { audioMessage: { ptt: true } } } }).kind).toBe('voice');
    expect(m({ viewOnceMessage: { message: { imageMessage: { caption: 'once' } } } })).toMatchObject({ kind: 'image', caption: 'once' });
    expect(m({ viewOnceMessageV2: { message: { videoMessage: {} } } }).kind).toBe('video');
    expect(m({ documentWithCaptionMessage: { message: { documentMessage: { caption: 'doc' } } } })).toMatchObject({ kind: 'document', caption: 'doc' });
    expect(m({ ephemeralMessage: { message: { viewOnceMessage: { message: { audioMessage: {} } } } } }).kind).toBe('audio');
  });

  it('does not treat reactions, polls, edits, deletions or empty payloads as customer text', () => {
    expect(m({ reactionMessage: { text: '👍' } }).kind).toBe('reaction');
    expect(m({ pollCreationMessage: { name: 'x' } }).kind).toBe('poll');
    expect(m({ editedMessage: { message: { protocolMessage: { editedMessage: { conversation: 'fixed' } } } } }).kind).toBe('other');
    expect(m({ protocolMessage: { type: 0 } }).kind).toBe('other');
    expect(m({}).kind).toBe('other');
    expect(m(null).kind).toBe('other');
    expect(classifyMessage(undefined).kind).toBe('other');
    expect(m({ someFutureMessage: { x: 1 } }).kind).toBe('other');
  });

  it('only "text" is answerable', () => {
    for (const kind of ['voice', 'audio', 'image', 'video', 'document', 'sticker', 'location', 'contact', 'reaction', 'poll', 'other', 'unsupported']) {
      expect(isAnswerableKind(kind)).toBe(false);
    }
    expect(isAnswerableKind('text')).toBe(true);
  });
});
