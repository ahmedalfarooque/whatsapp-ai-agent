import type Database from 'better-sqlite3';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { listCustomerVisibleOffers, type OfferView } from './offerRepo';
import { inspectOfferFile, type OfferFileProblem, type OfferFileSlot } from './offerFiles';

/**
 * The attachments (picture, supporting file) of the offers a customer can see right now, ready to be sent as real WhatsApp media.
 * Only offers returned by listCustomerVisibleOffers() for THIS business are considered — published, inside their validity window,
 * customer-visible, not draft/finished/archived/deleted — and each file is resolved only among this business's own documents.
 */

/** A safety cap per request so a long offer list can never flood a chat. Skipped files are reported, never dropped silently. */
export const MAX_OFFER_MEDIA_FILES = 12;

/**
 * WhatsApp shows at most 1,024 characters under a picture. The offers text goes in the picture's caption (one message) only when it
 * fits; a longer list is sent as ordinary text plus the pictures, so nothing is ever cut off.
 */
export const MAX_IMAGE_CAPTION_CHARS = 1024;

export interface OfferMediaItem {
  offerId: number;
  documentId: number;
  kind: 'image' | 'document';
  /** The offer's title in the customer's language: the caption under the picture or file. */
  title: string;
  /** The name WhatsApp shows for a file (title + extension). Never a server path. */
  fileName: string;
  mimeType: string;
  /** Server-side location, used only to read the bytes. Never sent to a customer or logged. */
  path: string;
}

export interface OfferMediaSkip {
  offerId: number;
  documentId: number;
  slot: OfferFileSlot;
  reason: OfferFileProblem | 'over_limit';
}

export interface CustomerOfferMedia {
  items: OfferMediaItem[];
  skipped: OfferMediaSkip[];
}

function fileNameFor(title: string, extension: string): string {
  // eslint-disable-next-line no-control-regex -- strip C0 control characters and path/shell characters from the name WhatsApp shows
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Offer';
  return `${cleaned}.${extension}`;
}

export function customerOfferMedia(
  lang: 'ar' | 'en',
  now: Date = new Date(),
  db: Database.Database = getDb(),
  accountId: number = currentAccountId(),
): CustomerOfferMedia {
  const items: OfferMediaItem[] = [];
  const skipped: OfferMediaSkip[] = [];
  const seen = new Set<number>();
  const offers: OfferView[] = listCustomerVisibleOffers(now, db, accountId);
  for (const offer of offers) {
    const title = (lang === 'ar' ? offer.title_ar : offer.title_en) || offer.title_en || offer.title_ar;
    for (const [slot, documentId] of [['image', offer.image_document_id], ['document', offer.document_id]] as const) {
      if (!documentId || seen.has(documentId)) continue;
      seen.add(documentId);
      const checked = inspectOfferFile(documentId, slot, accountId, db);
      if (!checked.ok) {
        skipped.push({ offerId: offer.id, documentId, slot, reason: checked.problem });
        continue;
      }
      if (items.length >= MAX_OFFER_MEDIA_FILES) {
        skipped.push({ offerId: offer.id, documentId, slot, reason: 'over_limit' });
        continue;
      }
      const { file } = checked;
      items.push({
        offerId: offer.id,
        documentId,
        kind: file.kind,
        title,
        fileName: fileNameFor(title, file.extension),
        mimeType: file.mimeType,
        path: file.path,
      });
    }
  }
  return { items, skipped };
}
