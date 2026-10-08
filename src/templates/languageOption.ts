/**
 * The permanent "Change language" line of the MAIN MENU.
 *
 * It is added when the main menu is rendered for a customer, not stored in each business's template: that way EVERY business
 * (the original one, the second one, any added later, any whose menu is regenerated or edited) shows it in the customer's own
 * language, nobody has to migrate stored text, and it can never be duplicated. A menu that already offers a language change in
 * its own words is left exactly as written.
 *
 * Sending "0" on the main menu opens the language choice (see menuRouter). In a sub-menu or a flow "0" still means "back".
 */
import type { CustomerLanguage } from '../memory/customerRepo';

export const LANGUAGE_OPTION_EN = '0️⃣ 🌐 Change language';
export const LANGUAGE_OPTION_AR = '0️⃣ 🌐 تغيير اللغة';

/** A last line like "Please reply with the option number." / "أرسل رقم الخيار." — the option goes just above it. */
const INSTRUCTION_LINE = /(option number|number of the option|رقم الخيار|رقم الاختيار)/i;
const ALREADY_OFFERED = /(change language|change the language|تغيير اللغة|تغيير لغة)/i;

export function withLanguageOption(menuText: string, language: CustomerLanguage): string {
  if (ALREADY_OFFERED.test(menuText)) return menuText;
  const line = language === 'ar' ? LANGUAGE_OPTION_AR : LANGUAGE_OPTION_EN;
  const lines = menuText.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1] ?? '';
  if (INSTRUCTION_LINE.test(last)) {
    // Keep a blank line before the instruction, and put the language option with the numbered options above it.
    const head = lines.slice(0, -1);
    while (head.length && head[head.length - 1]!.trim() === '') head.pop();
    return [...head, line, '', last].join('\n');
  }
  return `${lines.join('\n')}\n\n${line}`;
}
