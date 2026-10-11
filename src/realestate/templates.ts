import type { TemplateDefault } from '../templates/defaults';
import { keycap } from '../automation/menuConfig';

/**
 * Customer-facing texts of the real estate entries (Buy, Sell, Explore Projects). They are seeded only for a business with the real estate
 * add-on (templates/genericDefaults.ts) and, like every template, can be edited in the Manual Reply Editor. They promise nothing: no
 * availability, price, timing or confirmation; the team follows up.
 */

const FOOT_EN = `\n\n${keycap(0)} Main Menu`;
const FOOT_AR = `\n\n${keycap(0)} القائمة الرئيسية`;

export function realEstateTemplateDefaults(): TemplateDefault[] {
  return [
    {
      key: 're_buy', category: 'Real Estate', titleAr: 'شراء عقار', titleEn: 'Buy a Property',
      en: `🏠 Buy a Property\n\nTell me what you are looking for in your own words — for example the type of property, the city or area, your budget and when you plan to buy. I will ask only what I still need, and you can skip or correct anything.\n\nOur team reviews every enquiry; nothing is confirmed in this chat. Please do not send identity documents or bank details here.${FOOT_EN}`,
      ar: `🏠 شراء عقار\n\nاكتب لي ما تبحث عنه بأسلوبك — مثل نوع العقار والمدينة أو الحي والميزانية ووقت الشراء المتوقع. سأسأل فقط عمّا أحتاجه، ويمكنك تخطي أي سؤال أو تعديل أي إجابة.\n\nيراجع فريقنا كل استفسار، ولا يتم تأكيد أي شيء في هذه المحادثة. يرجى عدم إرسال وثائق الهوية أو البيانات البنكية هنا.${FOOT_AR}`,
    },
    {
      key: 're_sell', category: 'Real Estate', titleAr: 'بيع عقار', titleEn: 'Sell a Property',
      en: `🏷️ Sell a Property\n\nTell me about the property you would like to sell — the type, the city and area, the size, and what you expect. I will ask a few short questions, one or two at a time, and you can skip or correct anything.\n\nA QMULATE advisor will review it with you; if documents are needed, the team will explain how to provide them securely. Please do not send ownership papers, identity documents or bank details in this chat.${FOOT_EN}`,
      ar: `🏷️ بيع عقار\n\nأخبرني عن العقار الذي ترغب في بيعه — نوعه والمدينة والحي والمساحة وما تتوقعه. سأطرح بضعة أسئلة قصيرة، سؤالاً أو اثنين في كل مرة، ويمكنك تخطي أي سؤال أو تعديل أي إجابة.\n\nسيراجعه معك مستشار من QMULATE، وإن لزمت مستندات سيشرح لك الفريق كيفية تقديمها بشكل آمن. يرجى عدم إرسال صكوك الملكية أو وثائق الهوية أو البيانات البنكية في هذه المحادثة.${FOOT_AR}`,
    },
    {
      key: 're_projects', category: 'Real Estate', titleAr: 'مشاريعنا', titleEn: 'Explore Our Projects',
      en: `🏗️ Our projects\n\n{projects}\n\nAsk me about any of them, or tell me what you are looking for. I only share what is recorded for each project; the team confirms everything else.${FOOT_EN}`,
      ar: `🏗️ مشاريعنا\n\n{projects}\n\nاسألني عن أي منها، أو أخبرني بما تبحث عنه. أشارك فقط ما هو مسجّل لكل مشروع، ويؤكد الفريق كل ما عدا ذلك.${FOOT_AR}`,
    },
    {
      key: 're_projects_none', category: 'Real Estate', titleAr: 'لا توجد مشاريع منشورة', titleEn: 'No Projects Published',
      en: `🏗️ Our projects\n\nThere are no projects published in this chat right now. Tell me what you are looking for — the type of property, the city or area and your budget — and our team will review your requirements and follow up.${FOOT_EN}`,
      ar: `🏗️ مشاريعنا\n\nلا توجد مشاريع منشورة في هذه المحادثة حالياً. أخبرني بما تبحث عنه — نوع العقار والمدينة أو الحي والميزانية — وسيراجع فريقنا متطلباتك ويتواصل معك.${FOOT_AR}`,
    },
  ];
}
