/**
 * The permanent "Inquiry Cart" entry of the MAIN MENU, for every business.
 *
 * Like the "Change language" line, it is added when the main menu is rendered, not stored in each business's template: the original
 * business (fixed menu), a business with a customised or regenerated menu, and any business added later all get it in the customer's
 * language with nothing to migrate, and it can never be duplicated. It takes the first number after the business's own items
 * (so 10 on a full menu, never a number the business already uses), which leaves "0" (change language / back) untouched. A menu
 * text that already mentions the cart in its own words is left exactly as written.
 */
import type { CustomerLanguage } from '../memory/customerRepo';
import type { MenuTables } from '../automation/menuConfig';

export const CART_OPTION_EN = '🛒 Inquiry Cart';
export const CART_OPTION_AR = '🛒 سلة الاستفسارات';

const KEYCAPS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const INSTRUCTION_LINE = /(option number|number of the option|رقم الخيار|رقم الاختيار)/i;
const ALREADY_OFFERED = /(inquiry cart|enquiry cart|سلة الاستفسار)/i;

/** The number the cart answers to in this business's main menu: one past its highest numbered item. */
export function cartOptionNumber(tables: Pick<MenuTables, 'main'>): number {
  const numbers = Object.keys(tables.main).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return (numbers.length ? Math.max(...numbers) : 0) + 1;
}

export function withCartOption(menuText: string, language: CustomerLanguage, number: number): string {
  if (ALREADY_OFFERED.test(menuText)) return menuText;
  const cap = KEYCAPS[number] ?? `${number}.`;
  const line = `${cap} ${language === 'ar' ? CART_OPTION_AR : CART_OPTION_EN}`;
  const lines = menuText.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1] ?? '';
  if (INSTRUCTION_LINE.test(last)) {
    const head = lines.slice(0, -1);
    while (head.length && head[head.length - 1]!.trim() === '') head.pop();
    return [...head, line, '', last].join('\n');
  }
  return `${lines.join('\n')}\n${line}`;
}
