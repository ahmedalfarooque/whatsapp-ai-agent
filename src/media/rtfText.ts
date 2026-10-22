/**
 * RTF to plain text, as a real single-pass reader (no regular-expression chain): it follows the group structure, so metadata groups are dropped as a whole however deeply
 * they nest, and it decodes text the way RTF defines it.
 *  - `\uN` is a SIGNED 16-bit UTF-16 code unit (surrogate pairs arrive as two of them) and is followed by `\ucN` fallback characters (default 1; a `\'hh` escape counts as
 *    one) that are SKIPPED — they are only for readers that do not understand Unicode. `\ucN` applies inside its group.
 *  - `\'hh` bytes are decoded with the code page of the current font's charset (Arabic 1256, Hebrew 1255, Cyrillic 1251, ...) or else the document's `\ansicpgN`, not as
 *    Latin-1; consecutive bytes are decoded together so multi-byte code pages work.
 *  - Destinations that are not body text (font / colour / style tables, document info, pictures, embedded objects, field instructions, list tables, theme data, and every
 *    `{\*\...}` ignorable group) are skipped, `\binN` raw data is jumped over, so no hexadecimal or binary payload ever reaches the text.
 *  - Paragraphs, lines, tabs and table cells/rows become line breaks, tabs and " | "; common typographic control words become their characters.
 * Bounded: nesting depth and output size are capped, and a malformed file (unbalanced braces, truncated escapes) is read as far as it goes — it never loops or throws.
 */
import { TextDecoder } from 'node:util';

export type RtfResult = { ok: true; text: string } | { ok: false; detail: string };

const MAX_DEPTH = 100;
const MAX_CHARS = 2_000_000;

/** Groups that are not document text. */
const SKIPPED_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'objdata', 'objclass', 'objname', 'result_placeholder', 'datastore', 'themedata', 'colorschememapping',
  'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'fldinst', 'bkmkstart', 'bkmkend', 'blipuid', 'pgdsctbl', 'fchars', 'lchars',
  'protusertbl', 'revtbl', 'mmathpr', 'filetbl', 'fontemb', 'template', 'private', 'wgrffmtfilter', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'pnseclvl', 'shpinst', 'nonshppict', 'shppict', 'userprops', 'passwordhash', 'defchp', 'defpap', 'upi', 'xe', 'tc', 'txe', 'rxe', 'ixe', 'factoidname', 'falt',
]);

const SPECIAL_CHARS: Record<string, string> = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ', qmspace: ' ',
  zwj: '‍', zwnj: '‌', ltrmark: '‎', rtlmark: '‏',
};

/** RTF font charset number to Windows code page (0 / 1 = the document's own). */
const CHARSET_CODEPAGE: Record<number, number> = { 77: 10000, 128: 932, 129: 949, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250 };
const DECODER_LABEL: Record<number, string> = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 65001: 'utf-8' };

const decoders = new Map<number, TextDecoder | null>();
function decoderFor(codepage: number): TextDecoder | null {
  if (decoders.has(codepage)) return decoders.get(codepage)!;
  let decoder: TextDecoder | null = null;
  try { decoder = new TextDecoder(DECODER_LABEL[codepage] ?? `windows-${codepage}`); } catch { decoder = null; }
  decoders.set(codepage, decoder);
  return decoder;
}
function decodeBytes(bytes: number[], codepage: number): string {
  const decoder = decoderFor(codepage) ?? decoderFor(1252);
  return decoder ? decoder.decode(Uint8Array.from(bytes)) : bytes.map((b) => String.fromCharCode(b)).join('');
}

const isAlpha = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const isDigit = (code: number): boolean => code >= 48 && code <= 57;
const isHex = (s: string): boolean => /^[0-9a-fA-F]{2}$/.test(s);

interface Frame { skip: boolean; uc: number; font: number }

/** `raw` is the file read byte-for-byte (latin1): bytes above 127 outside `\'hh` escapes are treated as raw bytes of the current code page. */
export function rtfToPlainText(raw: string): RtfResult {
  const n = raw.length;
  const stack: Frame[] = [];
  let cur: Frame = { skip: false, uc: 1, font: -1 };
  let docCodepage = 1252;
  const fontCharset = new Map<number, number>();
  let fontTableDepth = 0; // > 0 while inside the font table (its \fN \fcharsetM pairs are read, its text is not)
  let tableFont = -1;
  let groupStart = false; // the next token is the first one of a just-opened group
  let buf = '';
  let pending: number[] = [];
  let pendingCodepage = 1252;

  const codepageFor = (font: number): number => {
    const charset = fontCharset.get(font);
    return (charset !== undefined ? CHARSET_CODEPAGE[charset] : undefined) ?? docCodepage;
  };
  const emit = (text: string): void => { if (!cur.skip && text) buf += text; };
  const flush = (): void => {
    if (pending.length === 0) return;
    const bytes = pending;
    pending = [];
    emit(decodeBytes(bytes, pendingCodepage));
  };
  const pushByte = (byte: number): void => {
    if (cur.skip) return;
    const codepage = codepageFor(cur.font);
    if (pending.length > 0 && pendingCodepage !== codepage) flush();
    pendingCodepage = codepage;
    pending.push(byte);
  };

  let i = 0;
  while (i < n && buf.length <= MAX_CHARS) {
    const code = raw.charCodeAt(i);
    if (code === 123) { // {
      flush();
      if (stack.length >= MAX_DEPTH) return { ok: false, detail: 'groups are nested too deeply' };
      stack.push(cur);
      cur = { ...cur };
      groupStart = true;
      i++;
      continue;
    }
    if (code === 125) { // }
      flush();
      const previous = stack.pop();
      if (previous) cur = previous;
      if (fontTableDepth > 0 && stack.length < fontTableDepth) fontTableDepth = 0;
      groupStart = false;
      i++;
      continue;
    }
    if (code === 92) { // backslash
      const next = i + 1 < n ? raw.charCodeAt(i + 1) : -1;
      if (next === -1) { i++; continue; }
      if (next === 39) { // \'hh
        const hex = raw.slice(i + 2, i + 4);
        if (isHex(hex)) { pushByte(parseInt(hex, 16)); i += 4; } else { i += 2; for (let d = 0; d < 2 && i < n && /[0-9a-fA-F]/.test(raw[i]!); d++) i++; } // a truncated escape is dropped together with the hex digit it did have
        groupStart = false;
        continue;
      }
      flush();
      if (isAlpha(next)) {
        let j = i + 1;
        while (j < n && isAlpha(raw.charCodeAt(j))) j++;
        const name = raw.slice(i + 1, j).toLowerCase();
        let param: number | null = null;
        let k = j;
        if (raw.charCodeAt(k) === 45) k++; // a minus sign
        const digitsStart = k;
        while (k < n && isDigit(raw.charCodeAt(k)) && k - digitsStart < 10) k++;
        if (k > digitsStart) { param = Number(raw.slice(j, k)); j = k; }
        if (raw.charCodeAt(j) === 32) j++; // the single space that ends a control word belongs to it
        const first = groupStart;
        groupStart = false;
        i = j;

        if (first && SKIPPED_DESTINATIONS.has(name)) {
          cur.skip = true;
          if (name === 'fonttbl') fontTableDepth = stack.length;
          continue;
        }
        if (fontTableDepth > 0) {
          if (name === 'f' && param !== null) tableFont = param;
          else if (name === 'fcharset' && param !== null && tableFont >= 0) fontCharset.set(tableFont, param);
          continue;
        }
        switch (name) {
          case 'ansicpg': if (param !== null) docCodepage = param; break;
          case 'uc': cur.uc = param !== null && param >= 0 ? Math.min(param, 8) : 1; break;
          case 'f': if (param !== null) cur.font = param; break;
          case 'u': {
            if (param === null) break; // `\u` without a number carries no character
            const unit = (((param ?? 0) % 65536) + 65536) % 65536; // signed 16-bit to a UTF-16 code unit
            emit(String.fromCharCode(unit));
            for (let skipped = 0; skipped < cur.uc; skipped++) { // the fallback characters, which only old readers use
              while (i < n && (raw.charCodeAt(i) === 10 || raw.charCodeAt(i) === 13)) i++;
              const c = raw.charCodeAt(i);
              if (c === 92 && raw.charCodeAt(i + 1) === 39) i += 4;
              else if (i < n && c !== 92 && c !== 123 && c !== 125) i++;
              else break;
            }
            break;
          }
          case 'bin': if (param !== null && param > 0) i += param; break; // raw binary data: jumped over, never read as text
          case 'par': case 'sect': case 'page': case 'line': emit('\n'); break;
          case 'tab': emit('\t'); break;
          case 'cell': case 'nestcell': if (!cur.skip) { if (buf.endsWith('\n')) buf = buf.slice(0, -1); buf += ' | '; } break;
          case 'row': case 'nestrow': if (!cur.skip) { if (buf.endsWith(' | ')) buf = buf.slice(0, -3); buf += '\n'; } break;
          default: { const special = SPECIAL_CHARS[name]; if (special) emit(special); }
        }
        continue;
      }
      // a control symbol: a backslash and one non-letter
      groupStart = groupStart && next === 42; // `\*` keeps "start of group" for the destination name that follows
      i += 2;
      switch (next) {
        case 92: case 123: case 125: emit(String.fromCharCode(next)); break; // \\ \{ \}
        case 126: emit(' '); break; // \~ non-breaking space
        case 95: emit('-'); break; // \_ non-breaking hyphen
        case 42: if (groupStart) cur.skip = true; break; // \* an ignorable destination: unknown to us, so dropped whole
        case 10: case 13: emit('\n'); if (next === 13 && raw.charCodeAt(i) === 10) i++; break; // a backslash at a line end is a paragraph
        default: break; // \- \| \: and the rest carry no text
      }
      continue;
    }
    if (code === 10 || code === 13) { i++; continue; } // line ends in the file are not text
    groupStart = false;
    if (code > 127 && code <= 255) { pushByte(code); i++; continue; }
    flush();
    let j = i;
    while (j < n) {
      const c = raw.charCodeAt(j);
      if (c === 123 || c === 125 || c === 92 || c === 10 || c === 13 || (c > 127 && c <= 255)) break;
      j++;
    }
    emit(raw.slice(i, j));
    i = j;
  }
  flush();
  return { ok: true, text: buf };
}
