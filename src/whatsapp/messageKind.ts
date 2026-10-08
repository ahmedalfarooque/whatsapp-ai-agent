/**
 * What kind of WhatsApp message a Baileys `message` payload is. Only a plain TEXT message (or a tap on a button/list
 * row, which carries its own text) enters the automatic conversation. Everything else — voice notes, audio, images,
 * video, documents, stickers, locations, contacts, reactions, polls, edits, deletions — is recorded for the team but
 * never answered automatically.
 *
 * A caption typed under a photo or file is NOT a standalone customer message: it is returned as `caption` so staff can
 * read it, but it never counts as `text`.
 *
 * Pure and dependency-free (no Baileys import) so every account's connection classifies messages the same way.
 */

export type InboundKind =
  | 'text'
  | 'voice'
  | 'audio'
  | 'image'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'reaction'
  | 'poll'
  | 'other';

export interface ClassifiedMessage {
  kind: InboundKind;
  /** The customer's typed text. Empty for every non-text kind. */
  text: string;
  /** Caption under media, for staff only. */
  caption: string;
}

type Content = Record<string, unknown> | null | undefined;

/** Wrappers that only add behaviour (disappearing, view-once, caption-on-document, ...) around the real message. */
const WRAPPERS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'deviceSentMessage',
  'botInvokeMessage',
] as const;

/** An edit arrives as a new message that wraps the edited content. It is not a new customer message. */
const EDIT_WRAPPERS = ['editedMessage', 'protocolMessage'] as const;

function unwrap(content: Content): Content {
  let current = content;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const wrapper = WRAPPERS.find((key) => current && typeof current[key] === 'object' && current[key] !== null);
    if (!wrapper) break;
    current = (current[wrapper] as { message?: Content }).message;
  }
  return current;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function classifyMessage(message: { message?: unknown } | null | undefined): ClassifiedMessage {
  const m = unwrap(message?.message as Content);
  if (!m) return { kind: 'other', text: '', caption: '' };

  if (EDIT_WRAPPERS.some((key) => m[key] !== undefined && m[key] !== null)) return { kind: 'other', text: '', caption: '' };

  const plain = str(m.conversation) || str((m.extendedTextMessage as { text?: unknown } | undefined)?.text);
  if (plain) return { kind: 'text', text: plain, caption: '' };

  // A tap on a button or list row is the customer's own choice and carries its text.
  const tapped = str((m.buttonsResponseMessage as { selectedDisplayText?: unknown } | undefined)?.selectedDisplayText)
    || str((m.listResponseMessage as { title?: unknown } | undefined)?.title)
    || str((m.templateButtonReplyMessage as { selectedDisplayText?: unknown } | undefined)?.selectedDisplayText);
  if (tapped) return { kind: 'text', text: tapped, caption: '' };

  const captionOf = (key: string) => str((m[key] as { caption?: unknown } | undefined)?.caption);
  if (m.audioMessage) {
    return { kind: (m.audioMessage as { ptt?: unknown }).ptt ? 'voice' : 'audio', text: '', caption: '' };
  }
  if (m.imageMessage) return { kind: 'image', text: '', caption: captionOf('imageMessage') };
  if (m.videoMessage || m.ptvMessage) return { kind: 'video', text: '', caption: captionOf('videoMessage') };
  if (m.documentMessage) return { kind: 'document', text: '', caption: captionOf('documentMessage') };
  if (m.stickerMessage) return { kind: 'sticker', text: '', caption: '' };
  if (m.locationMessage || m.liveLocationMessage) return { kind: 'location', text: '', caption: '' };
  if (m.contactMessage || m.contactsArrayMessage) return { kind: 'contact', text: '', caption: '' };
  if (m.reactionMessage) return { kind: 'reaction', text: '', caption: '' };
  if (m.pollCreationMessage || m.pollCreationMessageV2 || m.pollCreationMessageV3 || m.pollUpdateMessage) return { kind: 'poll', text: '', caption: '' };
  return { kind: 'other', text: '', caption: '' };
}

/** True for a message the assistant may answer automatically. */
export function isAnswerableKind(kind: string): boolean {
  return kind === 'text';
}
