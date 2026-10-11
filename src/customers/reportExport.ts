import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { getDb } from '../memory/db';
import { currentAccountId } from '../accounts/accountContext';
import { getAccount } from '../accounts/accountRepo';
import { getBusinessSettings } from '../config/businessSettings';
import { statusLabel } from '../requests/requestService';
import type { CustomerRequestStatus } from '../memory/customerRequestRepo';
import { allDirectoryRows, quotationExportRows, reportSummary, type DirectoryParams, type ReportRange } from './customerReports';
import { buildXlsx, type XlsxCell } from './xlsx';

/**
 * Customer Report exports in Excel (.xlsx) and a print-ready report (saved as PDF from the browser's print dialog).
 *
 * Both are built from ONE dataset: the same queries, filters, business and date range as the screen, so a file always matches what
 * staff saw. The dataset also carries the context (business, report, dates, every active filter, when it was made, how many records),
 * and both formats print it. The business is always the caller's selected one; nothing here accepts an account id.
 *
 * Why the PDF is a print view and not a server-made binary: Arabic needs real text shaping and right-to-left layout, which the
 * browser's print engine does perfectly and a small PDF library does not (the alternatives are a headless browser, which this server
 * does not have, or bundling fonts and a layout engine for a feature the print dialog already provides). The print view is a complete
 * HTML report with its own print styles (A4 landscape, repeating header, RTL for Arabic) and no script.
 */

export type ExportLang = 'en' | 'ar';
export type ExportDatasetKind = 'customers' | 'quotations' | 'summary';

export interface ExportDataset {
  kind: ExportDatasetKind;
  lang: ExportLang;
  title: string;
  /** Business name, report context and filters: label/value pairs. */
  info: { label: string; value: string }[];
  headers: string[];
  rows: XlsxCell[][];
  /** The real number of records matching the filters (rows may be limited). */
  total: number;
  truncated: boolean;
}

const t = (lang: ExportLang, en: string, ar: string): string => (lang === 'ar' ? ar : en);

const CUSTOMER_HEADERS: [string, string][] = [
  ['Customer ID', 'رقم العميل'], ['WhatsApp number', 'رقم واتساب'], ['Name', 'الاسم'], ['Company', 'الشركة'], ['Email', 'البريد الإلكتروني'], ['Language', 'اللغة'],
  ['First contact', 'أول تواصل'], ['Last interaction', 'آخر تفاعل'], ['Inquiries', 'الاستفسارات'], ['Appointments', 'المواعيد'], ['Open requests', 'الطلبات المفتوحة'],
  ['Quotations sent', 'عروض الأسعار المرسلة'], ['Files', 'الملفات'], ['Open cart', 'سلة مفتوحة'], ['Next follow-up', 'المتابعة التالية'],
];
const QUOTATION_HEADERS: [string, string][] = [
  ['Reference', 'المرجع'], ['Status', 'الحالة'], ['Source', 'المصدر'], ['Created', 'تاريخ الإنشاء'], ['Updated', 'آخر تحديث'], ['WhatsApp number', 'رقم واتساب'],
  ['Customer', 'العميل'], ['Company', 'الشركة'], ['Latest quotation', 'آخر عرض سعر'], ['Total', 'الإجمالي'], ['Currency', 'العملة'], ['Sent at', 'وقت الإرسال'],
];
const METRIC_LABELS: Record<string, [string, string]> = {
  totalCustomers: ['Total customers', 'إجمالي العملاء'], newCustomers: ['New in period', 'جدد في الفترة'], activeCustomers: ['Active in period', 'نشطون في الفترة'],
  customersWithInquiries: ['With requests in period', 'لديهم طلبات في الفترة'], inquiries: ['Quotation requests', 'طلبات عروض الأسعار'], appointmentRequests: ['Appointment requests', 'طلبات المواعيد'],
  quotationsSent: ['Quotations delivered', 'عروض الأسعار المسلّمة'], awaitingSend: ['Approved, not yet sent', 'تمت الموافقة ولم تُرسل بعد'], openRequests: ['Open requests', 'الطلبات المفتوحة'],
  cartsSubmitted: ['Carts submitted', 'سلال مُرسلة'], openCarts: ['Open carts', 'سلال مفتوحة'], staleCarts: ['Carts idle 7+ days', 'سلال خاملة 7 أيام فأكثر'],
  documentsReceived: ['Documents received', 'مستندات مستلمة'], documentsSent: ['Documents sent', 'مستندات مرسلة'], filesNeedingReview: ['Files to review', 'ملفات للمراجعة'],
  followUpsOutstanding: ['Follow-ups outstanding', 'متابعات معلّقة'], followUpsOverdue: ['Follow-ups overdue', 'متابعات متأخرة'],
};
const SOURCE: Record<string, [string, string]> = { menu: ['Menu', 'القائمة'], cart: ['Inquiry cart', 'سلة الاستفسارات'], dashboard: ['Dashboard', 'لوحة التحكم'], whatsapp: ['WhatsApp', 'واتساب'] };
const LANGUAGE_NAME: Record<string, [string, string]> = { en: ['English', 'الإنجليزية'], ar: ['Arabic', 'العربية'] };

function languageName(code: string | null, lang: ExportLang): string {
  if (!code) return '';
  const names = LANGUAGE_NAME[code];
  return names ? names[lang === 'ar' ? 1 : 0] : code;
}

function rangeLabel(range: ReportRange, lang: ExportLang): string {
  if (!range.from && !range.to) return t(lang, 'All dates', 'كل التواريخ');
  return `${range.from || t(lang, 'the beginning', 'البداية')} → ${range.to || t(lang, 'today', 'اليوم')}`;
}

/** Every active filter, in words, so a printed or exported file says what it contains. */
function filterLines(params: DirectoryParams, lang: ExportLang): string[] {
  const out: string[] = [];
  if (params.search) out.push(`${t(lang, 'Search', 'بحث')}: ${params.search}`);
  if (params.language) out.push(`${t(lang, 'Language', 'اللغة')}: ${languageName(params.language, lang)}`);
  if (params.requestStatus) out.push(`${t(lang, 'Request status', 'حالة الطلب')}: ${statusLabel(params.requestStatus as CustomerRequestStatus, lang)}`);
  if (params.openOnly) out.push(t(lang, 'Only customers with open work', 'العملاء الذين لديهم أعمال مفتوحة فقط'));
  if (params.hasFiles) out.push(t(lang, 'Only customers with documents', 'العملاء الذين لديهم مستندات فقط'));
  if (params.followUp) out.push(`${t(lang, 'Follow-ups', 'المتابعات')}: ${params.followUp === 'overdue' ? t(lang, 'overdue', 'متأخرة') : t(lang, 'outstanding', 'معلّقة')}`);
  if (params.sort && params.sort !== 'recent') out.push(`${t(lang, 'Sorted by', 'الترتيب حسب')}: ${params.sort === 'name' ? t(lang, 'name', 'الاسم') : t(lang, 'number of inquiries', 'عدد الاستفسارات')}`);
  return out;
}

export function buildExportDataset(
  kind: ExportDatasetKind,
  params: DirectoryParams,
  lang: ExportLang,
  options: { db?: Database.Database; accountId?: number; now?: Date } = {},
): ExportDataset {
  const db = options.db ?? getDb();
  const accountId = options.accountId ?? currentAccountId();
  const account = getAccount(accountId, db);
  const timezone = getBusinessSettings(accountId).businessTimezone;
  const generated = DateTime.fromJSDate(options.now ?? new Date()).setZone(timezone || 'UTC');
  const range: ReportRange = { from: params.from, to: params.to };
  const base = (title: string, filters: string[], total: number, truncated: boolean) => {
    const info = [
      { label: t(lang, 'Business', 'النشاط'), value: account?.name ?? `#${accountId}` },
      { label: t(lang, 'Report', 'التقرير'), value: title },
      { label: t(lang, 'Date range', 'الفترة'), value: rangeLabel(range, lang) },
      { label: t(lang, 'Filters', 'عوامل التصفية'), value: filters.length ? filters.join(' · ') : t(lang, 'None', 'لا يوجد') },
      { label: t(lang, 'Records', 'السجلات'), value: truncated ? t(lang, `${total} (the first rows are included, up to the export limit)`, `${total} (تُدرج الصفوف الأولى حتى حد التصدير)`) : String(total) },
      { label: t(lang, 'Generated', 'أُنشئ في'), value: `${generated.toFormat('yyyy-LL-dd HH:mm')} (${timezone || 'UTC'})` },
    ];
    return info;
  };

  if (kind === 'quotations') {
    const { rows, total, truncated } = quotationExportRows(range, db, accountId);
    const title = t(lang, 'Quotation requests', 'طلبات عروض الأسعار');
    return {
      kind, lang, title, total, truncated, info: base(title, [], total, truncated), headers: QUOTATION_HEADERS.map((h) => h[lang === 'ar' ? 1 : 0]),
      rows: rows.map((r) => [
        r.reference, statusLabel(r.status as CustomerRequestStatus, lang), SOURCE[r.source]?.[lang === 'ar' ? 1 : 0] ?? r.source, r.created_at, r.updated_at, r.wa_id,
        r.display_name, r.company_name, r.quote_number, r.total_minor === null ? null : Number((r.total_minor / 100).toFixed(2)), r.currency, r.sent_at,
      ]),
    };
  }

  if (kind === 'summary') {
    const summary = reportSummary(range, db, accountId);
    const title = t(lang, 'Customer report summary', 'ملخص تقرير العملاء');
    const rows: XlsxCell[][] = [];
    for (const [key, value] of Object.entries(summary.metrics)) {
      if (key === 'quotationsByStatus') continue;
      rows.push([(METRIC_LABELS[key] ?? [key, key])[lang === 'ar' ? 1 : 0], value as number]);
    }
    for (const [status, count] of Object.entries(summary.metrics.quotationsByStatus)) {
      rows.push([`${t(lang, 'Quotation requests', 'طلبات عروض الأسعار')} · ${statusLabel(status as CustomerRequestStatus, lang)}`, count]);
    }
    return { kind, lang, title, total: rows.length, truncated: false, info: base(title, [], rows.length, false), headers: [t(lang, 'Metric', 'المؤشر'), t(lang, 'Value', 'القيمة')], rows };
  }

  const filters = filterLines(params, lang);
  const { rows, total, truncated } = allDirectoryRows(params, db, accountId);
  const title = t(lang, 'Customers', 'العملاء');
  return {
    kind, lang, title, total, truncated, info: base(title, filters, total, truncated), headers: CUSTOMER_HEADERS.map((h) => h[lang === 'ar' ? 1 : 0]),
    rows: rows.map((r) => [
      r.id, r.wa_id, r.display_name, r.company_name, r.email, languageName(r.language, lang), r.created_at, r.lastInteractionAt, r.inquiries, r.appointments, r.openRequests,
      r.quotationsSent, r.files, r.openCart ? t(lang, 'yes', 'نعم') : t(lang, 'no', 'لا'), r.nextFollowUpAt,
    ]),
  };
}

export function datasetToXlsx(data: ExportDataset): Buffer {
  const rtl = data.lang === 'ar';
  return buildXlsx([
    { name: data.title, rows: [data.headers, ...data.rows], rtl },
    { name: t(data.lang, 'Report info', 'معلومات التقرير'), rows: [[t(data.lang, 'Item', 'البند'), t(data.lang, 'Value', 'القيمة')], ...data.info.map((i) => [i.label, i.value])], rtl },
  ]);
}

const escapeHtml = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A complete, script-free HTML report. Open it and use Print → Save as PDF. */
export function datasetToPrintHtml(data: ExportDataset): string {
  const rtl = data.lang === 'ar';
  const note = t(data.lang, 'Use Print → Save as PDF to keep a copy.', 'استخدم طباعة ← حفظ بصيغة PDF للاحتفاظ بنسخة.');
  const cells = (row: XlsxCell[]): string => row.map((v) => `<td>${v === null || v === undefined || v === '' ? '' : `<bdi>${escapeHtml(v)}</bdi>`}</td>`).join('');
  return `<!doctype html>
<html lang="${data.lang}" dir="${rtl ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(`${data.title} — ${data.info[0]?.value ?? ''}`)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; color: #14202b; background: #fff; font: 13px/1.5 "Segoe UI", Tahoma, "Noto Sans Arabic", Arial, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .note { margin: 0 0 16px; color: #5b6b78; font-size: 12px; }
  table { border-collapse: collapse; width: 100%; }
  .info td { padding: 3px 10px 3px 0; vertical-align: top; border: 0; }
  [dir=rtl] .info td { padding: 3px 0 3px 10px; }
  .info td:first-child { color: #5b6b78; white-space: nowrap; width: 1%; }
  .data { margin-top: 16px; }
  .data { font-size: 10.5px; }
  .data th, .data td { border: 1px solid #cfd8de; padding: 4px 6px; text-align: start; vertical-align: top; overflow-wrap: break-word; word-break: normal; }
  .data th { background: #e6f3f5; font-weight: 700; }
  .data thead { display: table-header-group; }
  .data tr { break-inside: avoid; }
  .empty { margin-top: 16px; color: #5b6b78; }
  @media print { body { padding: 0; } .note { display: none; } }
</style>
</head>
<body>
<h1>${escapeHtml(data.title)}</h1>
<p class="note">${escapeHtml(note)}</p>
<table class="info"><tbody>
${data.info.map((i) => `<tr><td>${escapeHtml(i.label)}</td><td><bdi>${escapeHtml(i.value)}</bdi></td></tr>`).join('\n')}
</tbody></table>
${data.rows.length ? `<table class="data"><thead><tr>${data.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
<tbody>
${data.rows.map((r) => `<tr>${cells(r)}</tr>`).join('\n')}
</tbody></table>` : `<p class="empty">${escapeHtml(t(data.lang, 'No records match these filters.', 'لا توجد سجلات مطابقة لعوامل التصفية هذه.'))}</p>`}
</body>
</html>
`;
}
