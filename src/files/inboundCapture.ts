import type { MediaDescriptor } from '../whatsapp/messageKind';
import { logger, maskWaId } from '../logger';
import { getDb } from '../memory/db';
import { getCustomerByWaId } from '../memory/customerRepo';
import { MAX_DOCUMENT_BYTES } from '../documents/documentStore';
import { CUSTOMER_FILE_EXTENSIONS, CustomerFileError, recordFailedCustomerFile, saveCustomerFile, type CustomerFile } from './customerFileRepo';
import { scheduleExtraction } from './fileTextExtraction';

/**
 * Keeps the files a customer sends (a photo of the car, a drawing, a purchase order) with that customer, in the business they wrote to.
 *
 * This NEVER answers anything and never blocks the conversation: it runs after the message was recorded and every failure is a safe
 * log line plus a visible record for staff ("could not be stored: too large"). Only documents and pictures are kept; video, audio,
 * voice notes and stickers are recorded as unsupported (not downloaded). A file is limited to the business document size cap, is
 * checked for type and content like any upload, and is stored once per WhatsApp message. When we are not sure who sent it (a chat
 * identified only by a privacy id with no phone number) the file is kept but flagged for staff to attach to the right customer.
 * Text extracted from a file is stored separately and is always unverified customer content.
 */

const DOWNLOAD_TIMEOUT_MS = 30_000;

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/plain': 'txt',
};

export interface InboundCaptureInput {
  accountId: number;
  /** The customer's chat id as the pipeline knows them (phone number or privacy id). */
  customerWaId: string;
  /** WhatsApp's id of the message that carried the file (namespaced exactly like the conversation row's). */
  whatsappMessageId: string;
  media: MediaDescriptor;
  caption?: string;
  /** False when the sender is only a privacy id with no known phone number. */
  identityCertain: boolean;
  download: () => Promise<Buffer>;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('download timed out')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

function conversationLink(accountId: number, customerId: number | null, whatsappMessageId: string): { conversationId: number | null; messageRowId: number | null } {
  if (customerId === null) return { conversationId: null, messageRowId: null };
  const row = getDb()
    .prepare(
      `SELECT m.id AS messageRowId, m.conversation_id AS conversationId FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.whatsapp_message_id = ? AND c.customer_id = ? AND c.whatsapp_account_id = ? ORDER BY m.id DESC LIMIT 1`,
    )
    .get(whatsappMessageId, customerId, accountId) as { messageRowId: number; conversationId: number } | undefined;
  return { conversationId: row?.conversationId ?? null, messageRowId: row?.messageRowId ?? null };
}

/** Returns the stored/recorded file, or undefined when nothing was recorded. Never throws. */
export async function captureInboundFile(input: InboundCaptureInput): Promise<CustomerFile | undefined> {
  const { accountId, media } = input;
  try {
    const customer = getCustomerByWaId(input.customerWaId, undefined, accountId);
    const customerId = customer?.id ?? null;
    const link = conversationLink(accountId, customerId, input.whatsappMessageId);
    const base = { customerId, caption: input.caption ?? null, ...link, whatsappMessageId: input.whatsappMessageId, accountId };

    if (media.kind !== 'image' && media.kind !== 'document') {
      return recordFailedCustomerFile({ ...base, kind: media.kind === 'video' ? 'video' : media.kind === 'sticker' ? 'other' : 'audio', status: 'unsupported', error: `${media.kind} files are not stored`, mimeType: media.mimeType, sizeBytes: media.fileLength });
    }
    const kind = media.kind;
    const mime = media.mimeType.split(';')[0]!.trim().toLowerCase();
    const ext = (media.fileName.includes('.') ? media.fileName.split('.').pop()!.toLowerCase() : '') || EXTENSION_BY_MIME[mime] || '';
    if (!CUSTOMER_FILE_EXTENSIONS.has(ext)) {
      return recordFailedCustomerFile({ ...base, kind, status: 'unsupported', error: `File type ${ext ? `.${ext}` : mime || 'unknown'} is not stored`, originalName: media.fileName || null, mimeType: mime, sizeBytes: media.fileLength });
    }
    if (media.fileLength !== null && media.fileLength > MAX_DOCUMENT_BYTES) {
      return recordFailedCustomerFile({ ...base, kind, status: 'too_large', error: `File is larger than ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB`, originalName: media.fileName || null, mimeType: mime, sizeBytes: media.fileLength });
    }

    let bytes: Buffer;
    try {
      bytes = await withTimeout(input.download(), DOWNLOAD_TIMEOUT_MS);
    } catch (error) {
      logger.warn({ account: accountId, customer: maskWaId(input.customerWaId), reason: String((error as Error).message).slice(0, 120) }, '[FILES] inbound file could not be downloaded');
      return recordFailedCustomerFile({ ...base, kind, status: 'failed', error: 'The file could not be downloaded from WhatsApp', originalName: media.fileName || null, mimeType: mime, sizeBytes: media.fileLength });
    }
    const originalName = media.fileName || `${kind === 'image' ? 'photo' : 'file'}-${input.whatsappMessageId.slice(-8)}.${ext}`;
    try {
      const saved = saveCustomerFile({ ...base, direction: 'inbound', bytes, originalName, mimeType: mime, needsReview: !input.identityCertain });
      if (saved.processing === 'stored') scheduleExtraction(saved); // the text of a PDF is read in the background; the message never waits for it
      return saved;
    } catch (error) {
      if (!(error instanceof CustomerFileError)) throw error;
      return recordFailedCustomerFile({ ...base, kind, status: bytes.length > MAX_DOCUMENT_BYTES ? 'too_large' : 'unsupported', error: error.message, originalName, mimeType: mime, sizeBytes: bytes.length });
    }
  } catch (error) {
    logger.error({ account: accountId, error: String((error as Error).message).slice(0, 200) }, '[FILES] inbound file capture failed');
    return undefined;
  }
}
