import { deflateRawSync } from 'node:zlib';

/**
 * A small, dependency-free writer for .xlsx workbooks (Office Open XML), enough for tabular exports: several sheets, a bold frozen
 * header row with an auto-filter, sensible column widths, numbers as numbers and everything else as text.
 *
 * Why not a library: none is installed, the ones that can write a workbook pull in a large dependency tree for features a report
 * does not use, and this format is small and fixed. Text is written as inline strings (never as formulas), so customer-supplied text
 * such as "=HYPERLINK(...)" is just text in the cell and can never run. Characters XML cannot carry are removed, very long text is
 * cut to Excel's cell limit, and sheet names are made valid.
 */

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
  name: string;
  /** First row is the header. */
  rows: XlsxCell[][];
  /** Right-to-left sheet (Arabic). */
  rtl?: boolean;
  /** Freeze the header row and add a filter to it. Default true. */
  header?: boolean;
}

const MAX_CELL_CHARS = 32_000;

// ------------------------------------------------------------------ zip (store/deflate, UTF-8 names)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

function zip(entries: ZipEntry[]): Buffer {
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // a fixed date keeps the output reproducible
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 6 });
    const useDeflate = compressed.length < entry.data.length;
    const body = useDeflate ? compressed : entry.data;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ------------------------------------------------------------------ xml helpers

/** Removes characters XML 1.0 cannot carry, then escapes the five special ones. */
export function xmlText(value: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿\uD800-\uDFFF]/gu, '');
  return clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Excel sheet names: at most 31 characters, none of []:*?/\ , not empty, unique within the workbook. */
export function sheetName(raw: string, taken: Set<string>): string {
  let name = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${n++}`;
  taken.add(name.toLowerCase());
  return name;
}

function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function textLength(value: XlsxCell): number {
  if (value === null || value === undefined) return 0;
  return String(value).split('\n').reduce((max, line) => Math.max(max, line.length), 0);
}

function sheetXml(sheet: XlsxSheet): string {
  const header = sheet.header !== false;
  const rows = sheet.rows;
  const columns = rows.reduce((max, r) => Math.max(max, r.length), 0) || 1;
  const widths: number[] = [];
  for (let c = 0; c < columns; c += 1) {
    const longest = rows.slice(0, 500).reduce((max, r) => Math.max(max, textLength(r[c])), 0);
    widths.push(Math.max(10, Math.min(60, longest + 2)));
  }
  const cell = (value: XlsxCell, r: number, c: number): string => {
    if (value === null || value === undefined || value === '') return '';
    const ref = `${columnLetter(c)}${r + 1}`;
    const style = header && r === 0 ? ' s="1"' : '';
    if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
    const text = String(value).slice(0, MAX_CELL_CHARS);
    return `<c r="${ref}" t="inlineStr"${style || ' s="2"'}><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
  };
  const body = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, c) => cell(v, i, c)).join('')}</row>`).join('');
  const last = `${columnLetter(columns - 1)}${Math.max(rows.length, 1)}`;
  const views = `<sheetViews><sheetView workbookViewId="0"${sheet.rtl ? ' rightToLeft="1"' : ''}>${header && rows.length > 1 ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${views}<sheetFormatPr defaultRowHeight="15"/>`
    + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${body}</sheetData>${header && rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : ''}</worksheet>`;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>`
  + `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>`
  + `<fill><patternFill patternType="solid"><fgColor rgb="FFE6F3F5"/><bgColor indexed="64"/></patternFill></fill></fills>`
  + `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>`
  + `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>`
  + `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>`
  + `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>`
  + `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>`
  + `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Builds the workbook file. Throws if there is no sheet. */
export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  if (!sheets.length) throw new Error('A workbook needs at least one sheet');
  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken) }));
  const entries: ZipEntry[] = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
        + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
        + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
        + named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
        + `</Types>`),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    },
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
        + `<sheets>${named.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
        + `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES_XML) },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s)) })),
  ];
  return zip(entries);
}
