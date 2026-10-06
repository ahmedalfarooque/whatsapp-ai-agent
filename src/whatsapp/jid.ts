/** Helpers for WhatsApp linked-device (Baileys) identifiers. */

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Converts Arabic-Indic numerals (١٢٣) to Western digits so "٢" routes like "2". */
export function normalizeNumerals(text: string): string {
  return text.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC_DIGITS.indexOf(d)));
}

/** Strips the device suffix and server from a JID: "9665...:12@s.whatsapp.net" -> "9665...". */
export function jidToUser(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? '';
}

/** "9665...:12@s.whatsapp.net" -> "+9665...". Returns null for non-phone JIDs (e.g. @lid). */
export function jidToPhoneNumber(jid: string | undefined | null): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const user = jidToUser(jid);
  return /^\d{6,15}$/.test(user) ? `+${user}` : null;
}

export function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

export function isBroadcastJid(jid: string): boolean {
  return jid === 'status@broadcast' || jid.endsWith('@broadcast');
}

/** True for a customer chat we should answer: personal number or linked-device LID, never groups/broadcasts. */
export function isDirectChatJid(jid: string): boolean {
  return /^[0-9]+(:[0-9]+)?@(s\.whatsapp\.net|lid)$/.test(jid);
}
