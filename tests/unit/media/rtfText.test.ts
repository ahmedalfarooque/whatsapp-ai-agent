import { describe, expect, it } from 'vitest';
import { rtfToPlainText } from '../../../src/media/rtfText';
import { extractDocumentText } from '../../../src/media/textExtractors';

/** Builds the \uN escapes a word processor writes for non-ASCII text (signed 16-bit values, surrogate pairs as two units, a fallback after each). */
function escapeUnicode(text: string, fallback = '?'): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (ch === '\n') out += '\\par ';
    else if (cp < 128) out += ch;
    else for (const unit of cp > 0xffff ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [cp]) out += `\\u${unit > 32767 ? unit - 65536 : unit}${fallback}`;
  }
  return out;
}
const doc = (body: string, head = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}') => `${head}\\pard\\f0 ${body}}`;
const plain = (raw: string): string => { const r = rtfToPlainText(raw); if (!r.ok) throw new Error(r.detail); return r.text.trim(); };
const read = (raw: string) => extractDocumentText({ bytes: Buffer.from(raw, 'latin1'), mimeType: 'application/rtf', fileName: 'a.rtf' });

describe('RTF Unicode text (Arabic and every other script)', () => {
  it('Arabic written as \\uN escapes with a one-character fallback reads as clean Arabic (no "Ø§Ù„Ã‡" garbage, no stray question marks)', () => {
    const arabic = 'مرحبا بالعالم';
    expect(plain(doc(escapeUnicode(arabic)))).toBe(arabic);
  });

  it('the fallback that follows \\uN is SKIPPED whether it is "?" or a \\\'hh escape (the reported corruption)', () => {
    expect(plain(doc("\\u1575\\'c7\\u1604\\'e1 end"))).toBe('ال end');
    expect(plain(doc('\\u1575?\\u1604? end'))).toBe('ال end');
  });

  it('\\ucN sets how many fallback characters follow, applies inside its group only, and \\uc0 means none', () => {
    expect(plain(doc('\\uc2\\u1575ab\\u1604cd end'))).toBe('ال end');
    expect(plain(doc('{\\uc2\\u1575ab}\\u1604? end'))).toBe('ال end'); // back to the default of one fallback after the group
    expect(plain(doc('\\uc0\\u1575?'))).toBe('ا?'); // nothing to skip: the "?" is real text
  });

  it('mixed Arabic / English text, digits (Western and Arabic-Indic), punctuation and symbols keep their order and spelling', () => {
    const text = 'Invoice رقم ٤٥٢١ — total 350.00 SAR (VAT 15%), ref: INV-2026/0045; "ok", it\'s 100% fine! مرحبا، شكراً';
    expect(plain(doc(escapeUnicode(text)))).toBe(text);
  });

  it('negative (signed) values, characters above U+7FFF and surrogate pairs (emoji) are decoded', () => {
    expect(plain(doc(escapeUnicode('ﻻ ﻻ 😀 日本語')))).toBe('ﻻ ﻻ 😀 日本語');
    expect(plain(doc('\\u-3845?'))).toBe(String.fromCharCode(-3845 + 65536));
  });

  it('escaped braces and backslashes are literal text, and line breaks inside the file are not text', () => {
    expect(plain(doc('a \\{b\\} \\\\ c'))).toBe('a {b} \\ c');
    expect(plain(doc('one\r\ntwo'))).toBe('onetwo');
  });
});

describe('RTF code pages (\\\'hh bytes)', () => {
  it('bytes are decoded with the document code page, not as Latin-1: Windows-1256 Arabic', () => {
    const head = '{\\rtf1\\ansi\\ansicpg1256\\deff0{\\fonttbl{\\f0\\fcharset178 Arial;}}';
    expect(plain(doc("\\'c7\\'e1\\'d3\\'e1\\'c7\\'e5", head))).toBe('السلاه'); // ا ل س ل ا ه
  });

  it('the charset of the CURRENT font decides, and consecutive bytes are decoded together (multi-byte code pages)', () => {
    const head = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fcharset0 Arial;}{\\f1\\fcharset178 Arial;}{\\f2\\fcharset204 Arial;}}';
    expect(plain(doc("caf\\'e9 \\f1\\'c7\\'e1 \\f2\\'c4\\'e0", head))).toBe('café ال Да');
    const sjis = '{\\rtf1\\ansi\\ansicpg932\\deff0{\\fonttbl{\\f0\\fcharset128 MS Gothic;}}';
    expect(plain(doc("\\'93\\'fa\\'96\\'7b", sjis))).toBe('日本'); // one two-byte character per pair
  });

  it('through the real extractor: Windows-1252 text and a paragraph break', async () => {
    const r = await read(doc("Hello caf\\'e9\\par Second line"));
    expect(r).toMatchObject({ ok: true, kind: 'rtf' });
    expect(r.ok && r.text).toBe('Hello café\nSecond line');
  });
});

describe('RTF header, metadata and binary groups', () => {
  it('font, colour and style tables, document info, generator and list tables are removed WHOLE, however deeply they nest', () => {
    const header = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0\\fswiss Times New Roman;}{\\f1\\fmodern Courier New;}{\\f2 Calibri{\\*\\falt Arial};}}'
      + '{\\colortbl;\\red255\\green0\\blue0;}{\\stylesheet{\\s0 Normal;}{\\s1 heading 1;}}'
      + '{\\*\\generator Riched20 10.0.19041}{\\info{\\title Secret Title}{\\author Jane Author}{\\company ACME{\\nested deep}}}'
      + '{\\*\\listtable{\\list\\listtemplateid1{\\listlevel\\levelnfc0}}}{\\*\\listoverridetable{\\listoverride\\listid1}}';
    const text = plain(`${header}\\pard\\f0 Real body text \\b bold\\b0  and more.\\par Second paragraph.}`);
    expect(text).toBe('Real body text bold and more.\nSecond paragraph.');
    for (const leaked of ['Times New Roman', 'Courier', 'Calibri', 'Arial', 'Secret Title', 'Jane Author', 'ACME', 'Riched20', 'heading 1', 'Normal', 'nested']) expect(text).not.toContain(leaked);
  });

  it('pictures and embedded objects (hexadecimal payloads) never leak into the text, and \\binN raw bytes are jumped over even when they contain braces', () => {
    const hex = '89504e470d0a1a0a0000000d49484452'.repeat(50);
    expect(plain(doc(`before {\\pict\\pngblip\\picw100\\pich100 ${hex}}after`))).toBe('before after');
    expect(plain(doc(`x {\\*\\shppict{\\pict\\jpegblip ${hex}}}{\\nonshppict{\\pict\\wmetafile8 ${hex}}} y`))).toBe('x  y'); // both picture groups vanish whole (the extractor's tidy step then collapses the double space)
    expect(plain(doc('a {\\pict\\wbitmap0\\bin7 {}}{\\ab}b'))).toBe('a b');
    expect(plain(doc(`a {\\object{\\*\\objdata ${hex}}{\\result visible}}b`))).not.toMatch(/[0-9a-f]{16}/);
  });

  it('field instructions are dropped but the field RESULT (what a reader sees) stays', () => {
    expect(plain(doc('See {\\field{\\*\\fldinst HYPERLINK "https://example.com"}{\\fldrslt our website}} today'))).toBe('See our website today');
  });

  it('table cells become " | " and rows become lines', async () => {
    const r = await read(doc('\\trowd\\cellx3000\\cellx6000\\intbl Item\\cell Price\\cell\\row\\intbl Polish\\cell 120\\cell\\row'));
    expect(r).toMatchObject({ ok: true, kind: 'rtf' });
    expect(r.ok && r.text).toBe('Item | Price\nPolish | 120');
  });

  it('typographic control words become their characters', () => {
    expect(plain(doc('a\\emdash b\\endash c\\bullet d\\lquote e\\rquote  \\ldblquote f\\rdblquote'))).toBe('a—b–c•d‘e’ “f”');
  });
});

describe('RTF robustness', () => {
  it('malformed files are read as far as they go and never throw: unbalanced braces, truncated escapes, a lone backslash', () => {
    expect(plain('{\\rtf1 {{{ still here')).toBe('still here');
    expect(plain('{\\rtf1 abc}}}} def')).toBe('abc def');
    expect(plain("{\\rtf1 x\\'4")).toBe('x');
    expect(plain('{\\rtf1 x\\u')).toBe('x'); // a bare \u carries no character (not a NUL)
    expect(plain('{\\rtf1 end\\')).toBe('end');
  });

  it('a group nested absurdly deep is refused as corrupt instead of exhausting the stack', async () => {
    const bomb = `{\\rtf1 ${'{'.repeat(5000)}x${'}'.repeat(5000)}}`;
    expect(rtfToPlainText(bomb)).toMatchObject({ ok: false });
    expect(await read(bomb)).toMatchObject({ ok: false, kind: 'rtf', reason: 'corrupt' });
  });

  it('a large document is read in linear time, and a huge digit string after a control word is bounded', () => {
    const big = doc('word '.repeat(400_000));
    const started = Date.now();
    expect(plain(big).length).toBeGreaterThan(1_000_000);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(rtfToPlainText(doc(`\\u${'9'.repeat(5000)}? tail`)).ok).toBe(true);
    expect(rtfToPlainText(doc(`\\b${'1'.repeat(100000)} tail`)).ok).toBe(true);
  });

  it('something that does not start like RTF is corrupt, as before', async () => {
    expect(await read('not rtf')).toMatchObject({ ok: false, reason: 'corrupt' });
  });
});
