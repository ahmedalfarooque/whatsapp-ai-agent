import { keycap, renderMenuList, type MenuConfig, type MenuItem } from '../../automation/menuConfig';
import type { BlueprintTemplate, BusinessBlueprint } from '../blueprint';

/**
 * QMULATE Real Estate Consultancy — a Saudi real estate consultancy, brokerage and property management platform.
 *
 * Every fact below comes from the company's own website (https://www.qmulate.ai and its Arabic pages, read on 2026-10-10)
 * or is a plain description of how this WhatsApp assistant behaves. Nothing else is stated: no prices, fees, commissions,
 * yields, listings, certifications, opening hours or WhatsApp number. Things the website does not say are left empty so the
 * assistant tells the customer that the team will confirm them.
 */

const NAME_EN = 'QMULATE Real Estate Consultancy';
const NAME_AR = 'QMULATE للاستشارات العقارية';
const SITE_EN = 'https://www.qmulate.ai';
const SITE_AR = 'https://www.qmulate.ai/ar';
const LICENCE_EN = 'Licensed by the Real Estate General Authority (REGA) under license numbers 2200005389 and 1200049558.';
const LICENCE_AR = 'مرخص من الهيئة العامة للعقار (REGA) بموجب الترخيصين رقم 2200005389 و1200049558.';
const TAGLINE_EN = 'Transforming Ownership into Enduring Value.';
const TAGLINE_AR = 'نحوّل الملكية إلى قيمة مستدامة.';
const RESPONSE_EN = 'We typically respond within one business day, and every introduction is treated with complete discretion.';
const RESPONSE_AR = 'نردّ عادةً في غضون يوم عمل واحد، ويُعامل كل تواصل بسرية تامة.';

const CONSULT = (id: string): MenuItem => ({ id, kind: 'appointment', labelEn: '📅 Request a consultation', labelAr: '📅 طلب استشارة' });

export const QMULATE_MENU: MenuConfig = {
  version: 1,
  items: [
    {
      id: 'ownership', kind: 'submenu', labelEn: '🏛️ Ownership Structuring & Governance', labelAr: '🏛️ هيكلة الملكية والحوكمة',
      children: [
        { id: 'ownercorp', kind: 'info', labelEn: '🏢 Corporates', labelAr: '🏢 الشركات' },
        { id: 'ownerfam', kind: 'info', labelEn: '👪 Individuals & Families', labelAr: '👪 الأفراد والأسر' },
        { id: 'ownerend', kind: 'info', labelEn: '📜 Endowments', labelAr: '📜 الأوقاف' },
        CONSULT('ownerconsult'),
      ],
    },
    {
      id: 'assets', kind: 'submenu', labelEn: '🏢 Real Estate Asset Management', labelAr: '🏢 إدارة الأصول العقارية',
      children: [
        { id: 'assetcorp', kind: 'info', labelEn: '🏢 Corporates', labelAr: '🏢 الشركات' },
        { id: 'assetfam', kind: 'info', labelEn: '👪 Individuals & Families', labelAr: '👪 الأفراد والأسر' },
        { id: 'assetend', kind: 'info', labelEn: '📜 Endowments', labelAr: '📜 الأوقاف' },
        CONSULT('assetconsult'),
      ],
    },
    {
      id: 'invest', kind: 'submenu', labelEn: '📈 Development & Investment', labelAr: '📈 التطوير والاستثمار',
      children: [
        { id: 'investcorp', kind: 'info', labelEn: '🏢 Corporates', labelAr: '🏢 الشركات' },
        { id: 'investfam', kind: 'info', labelEn: '👪 Individuals & Families', labelAr: '👪 الأفراد والأسر' },
        { id: 'investend', kind: 'info', labelEn: '📜 Endowments', labelAr: '📜 الأوقاف' },
        CONSULT('investconsult'),
      ],
    },
    {
      id: 'advisory', kind: 'submenu', labelEn: '🤝 Consultancy & Brokerage', labelAr: '🤝 الاستشارات والوساطة العقارية',
      children: [
        { id: 'advisoryinfo', kind: 'info', labelEn: '🤝 What we cover', labelAr: '🤝 ما نقدمه' },
        { id: 'advisoryinquiry', kind: 'quotation', labelEn: '📋 Send an inquiry', labelAr: '📋 إرسال استفسار' },
        CONSULT('advisoryconsult'),
      ],
    },
    {
      id: 'clients', kind: 'submenu', labelEn: '👥 Services by Client Type', labelAr: '👥 الخدمات حسب نوع العميل',
      children: [
        { id: 'clientfam', kind: 'info', labelEn: '👪 Individuals & Families', labelAr: '👪 الأفراد والأسر' },
        { id: 'clientend', kind: 'info', labelEn: '📜 Endowments', labelAr: '📜 الأوقاف' },
        { id: 'clientcorp', kind: 'info', labelEn: '🏢 Corporates', labelAr: '🏢 الشركات' },
        CONSULT('clientconsult'),
      ],
    },
    { id: 'about', kind: 'info', labelEn: 'ℹ️ About QMULATE & Licensing', labelAr: 'ℹ️ عن QMULATE والتراخيص' },
    { id: 'contact', kind: 'info', labelEn: '📍 Contact & Address', labelAr: '📍 التواصل والعنوان' },
    { id: 'consult', kind: 'appointment', labelEn: '📅 Request a Consultation', labelAr: '📅 طلب استشارة' },
    { id: 'staff', kind: 'handoff', labelEn: '💬 Talk to Our Team', labelAr: '💬 التحدث مع فريقنا' },
  ],
};

// ------------------------------------------------------------------ page builders

const K0 = keycap(0);
const MENU_EN = `${K0} Main Menu`;
const MENU_AR = `${K0} القائمة الرئيسية`;

/** An information page inside a sub-menu: the customer stays in that sub-menu, so its numbers keep working. */
function subPage(key: string, titleEn: string, titleAr: string, bodyEn: string, bodyAr: string, ctaEn: string, ctaAr: string): BlueprintTemplate {
  return {
    key,
    en: `${titleEn}\n\n${bodyEn}\n\n${ctaEn}\n${MENU_EN}`,
    ar: `${titleAr}\n\n${bodyAr}\n\n${ctaAr}\n${MENU_AR}`,
  };
}

const CONSULT_CTA_EN = `To discuss your situation, reply ${keycap(4)} to request a consultation.`;
const CONSULT_CTA_AR = `لمناقشة وضعكم، أرسل ${keycap(4)} لطلب استشارة.`;

function submenuList(item: MenuItem, introEn: string, introAr: string): BlueprintTemplate {
  const children = item.children ?? [];
  return {
    key: `menu_${item.id}`,
    en: `${item.labelEn}\n\n${introEn}\n\n${renderMenuList(children, 'en')}\n\n${MENU_EN}`,
    ar: `${item.labelAr}\n\n${introAr}\n\n${renderMenuList(children, 'ar')}\n\n${MENU_AR}`,
  };
}

const item = (id: string): MenuItem => QMULATE_MENU.items.find((i) => i.id === id)!;

const MAIN_MENU: BlueprintTemplate = {
  key: 'main_menu',
  en: `Welcome to {business}\n\n“${TAGLINE_EN}”\n\nHow can we help you today?\n\n${renderMenuList(QMULATE_MENU.items, 'en')}\n\nPlease reply with the option number.`,
  ar: `أهلاً بك في {business}\n\n«${TAGLINE_AR}»\n\nكيف يمكننا خدمتك اليوم؟\n\n${renderMenuList(QMULATE_MENU.items, 'ar')}\n\nأرسل رقم الخيار.`,
};

const TEMPLATES: BlueprintTemplate[] = [
  MAIN_MENU,

  // ---- Ownership Structuring & Governance
  submenuList(item('ownership'), 'We help organise who owns, who decides and how ownership is sustained. Choose the client type that fits you:', 'نساعد في تنظيم من يملك ومن يقرر وكيف تستمر الملكية. اختر نوع العميل المناسب لك:'),
  subPage('menu_ownership_ownercorp', '🏢 Ownership Structuring & Governance — Corporates', '🏢 هيكلة الملكية والحوكمة — الشركات',
    'We structure ownership and the relationships between shareholders, partners and investors, so that authority is clear, decisions are supported and the business can be sustained.',
    'نهيكل الملكية والعلاقات بين المساهمين والشركاء والمستثمرين، بما يحدد الصلاحيات بوضوح، ويدعم اتخاذ القرارات، ويحافظ على استدامة الأعمال.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_ownership_ownerfam', '👪 Ownership Structuring & Governance — Individuals & Families', '👪 هيكلة الملكية والحوكمة — الأفراد والأسر',
    'We organise personal assets and investments within a framework that supports governance, informed decisions and long-term planning.',
    'ننظّم الأصول والاستثمارات الشخصية ضمن إطار يدعم الحوكمة واتخاذ القرارات المستنيرة والتخطيط طويل الأمد.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_ownership_ownerend', '📜 Ownership Structuring & Governance — Endowments', '📜 هيكلة الملكية والحوكمة — الأوقاف',
    'We build governance frameworks that support the endowment’s objectives, its oversight and its continuity across generations.',
    'نبني أطر حوكمة تدعم أهداف الوقف والرقابة عليه واستمراريته عبر الأجيال.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),

  // ---- Real Estate Asset Management
  submenuList(item('assets'), 'Leasing, operations, maintenance and collections — managed for owners. Choose the client type that fits you:', 'التأجير والتشغيل والصيانة والتحصيل — تُدار نيابةً عن المالك. اختر نوع العميل المناسب لك:'),
  subPage('menu_assets_assetcorp', '🏢 Real Estate Asset Management — Corporates', '🏢 إدارة الأصول العقارية — الشركات',
    'Portfolio management that protects asset value and improves performance.',
    'إدارة المحافظ العقارية بما يحمي قيمة الأصول ويحسّن أداءها.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_assets_assetfam', '👪 Real Estate Asset Management — Individuals & Families', '👪 إدارة الأصول العقارية — الأفراد والأسر',
    'We manage personal and investment properties, with visibility of how they perform and protection of the asset.',
    'ندير العقارات الشخصية والاستثمارية مع وضوح في متابعة الأداء وحماية للأصل.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_assets_assetend', '📜 Real Estate Asset Management — Endowments', '📜 إدارة الأصول العقارية — الأوقاف',
    'We operate endowment assets to maximise their benefit and sustainability, in line with the endowment’s objectives.',
    'نشغّل أصول الأوقاف بما يعظّم نفعها واستدامتها، بما يتوافق مع أهداف الوقف.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),

  // ---- Development & Investment
  submenuList(item('invest'), 'Opportunities to expand, develop and reposition, and to assess investment decisions. Choose the client type that fits you:', 'فرص التوسع والتطوير وإعادة التموضع، وتقييم قرارات الاستثمار. اختر نوع العميل المناسب لك:'),
  subPage('menu_invest_investcorp', '🏢 Development & Investment — Corporates', '🏢 التطوير والاستثمار — الشركات',
    'We look at opportunities for expansion, development and repositioning.',
    'ندرس فرص التوسع والتطوير وإعادة التموضع.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_invest_investfam', '👪 Development & Investment — Individuals & Families', '👪 التطوير والاستثمار — الأفراد والأسر',
    'We assess investment opportunities and provide consultancy and brokerage for acquisitions, sales, development, retention or exit decisions.',
    'نقيّم الفرص الاستثمارية ونقدم الاستشارات والوساطة في قرارات الشراء والبيع والتطوير والاحتفاظ أو الخروج.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_invest_investend', '📜 Development & Investment — Endowments', '📜 التطوير والاستثمار — الأوقاف',
    'We evaluate and develop endowment assets through sustainable investments.',
    'نقيّم أصول الأوقاف ونطوّرها عبر استثمارات مستدامة.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),

  // ---- Consultancy & Brokerage
  submenuList(item('advisory'), 'Real estate consultancy and brokerage, with property management behind it. Choose an option:', 'الاستشارات العقارية والوساطة العقارية، تدعمها إدارة الأملاك. اختر أحد الخيارات:'),
  subPage('menu_advisory_advisoryinfo', '🤝 Consultancy & Brokerage', '🤝 الاستشارات والوساطة العقارية',
    `QMULATE is a real estate consultancy, brokerage and property management platform. Our consultancy and brokerage support acquisitions, sales, development, retention or exit decisions.\n\nPlease do not share confidential documents in this chat — our team will contact you to discuss next steps. ${RESPONSE_EN}`,
    `QMULATE منصة عقارية تقدم خدمات الاستشارات العقارية والوساطة العقارية وإدارة الأملاك. وتدعم استشاراتنا ووساطتنا قرارات الشراء والبيع والتطوير والاحتفاظ أو الخروج.\n\nيرجى عدم إرسال مستندات سرية في هذه المحادثة، وسيتواصل معك فريقنا لمناقشة الخطوات التالية. ${RESPONSE_AR}`,
    `Reply ${keycap(2)} to send an inquiry, or ${keycap(3)} to request a consultation.`,
    `أرسل ${keycap(2)} لإرسال استفسار، أو ${keycap(3)} لطلب استشارة.`),

  // ---- Services by client type
  submenuList(item('clients'), 'See what we offer each type of client, across ownership structuring, asset management and investment:', 'اطّلع على ما نقدمه لكل نوع من العملاء في هيكلة الملكية وإدارة الأصول والاستثمار:'),
  subPage('menu_clients_clientfam', '👪 Individuals & Families', '👪 الأفراد والأسر',
    '• Ownership structuring & governance: organising personal assets and investments within a framework for governance, informed decisions and long-term planning.\n• Asset management: managing personal and investment properties, with visibility of performance and protection of the asset.\n• Development & investment: assessing opportunities, with consultancy and brokerage for acquisitions, sales, development, retention or exit decisions.',
    '• هيكلة الملكية والحوكمة: تنظيم الأصول والاستثمارات الشخصية ضمن إطار للحوكمة والقرارات المستنيرة والتخطيط طويل الأمد.\n• إدارة الأصول: إدارة العقارات الشخصية والاستثمارية مع وضوح في متابعة الأداء وحماية للأصل.\n• التطوير والاستثمار: تقييم الفرص مع الاستشارات والوساطة في قرارات الشراء والبيع والتطوير والاحتفاظ أو الخروج.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_clients_clientend', '📜 Endowments', '📜 الأوقاف',
    '• Ownership structuring & governance: governance frameworks that support the endowment’s objectives, oversight and continuity across generations.\n• Asset management: operating endowment assets to maximise their benefit and sustainability, in line with the endowment’s objectives.\n• Development & investment: evaluating and developing endowment assets through sustainable investments.',
    '• هيكلة الملكية والحوكمة: أطر حوكمة تدعم أهداف الوقف والرقابة عليه واستمراريته عبر الأجيال.\n• إدارة الأصول: تشغيل أصول الأوقاف بما يعظّم نفعها واستدامتها بما يتوافق مع أهداف الوقف.\n• التطوير والاستثمار: تقييم أصول الأوقاف وتطويرها عبر استثمارات مستدامة.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),
  subPage('menu_clients_clientcorp', '🏢 Corporates', '🏢 الشركات',
    '• Ownership structuring & governance: structuring ownership and the relationships between shareholders, partners and investors, so authority is clear and decisions are supported.\n• Asset management: portfolio management that protects asset value and improves performance.\n• Development & investment: opportunities for expansion, development and repositioning.',
    '• هيكلة الملكية والحوكمة: هيكلة الملكية والعلاقات بين المساهمين والشركاء والمستثمرين، بما يحدد الصلاحيات ويدعم القرارات.\n• إدارة الأصول: إدارة المحافظ العقارية بما يحمي قيمة الأصول ويحسّن أداءها.\n• التطوير والاستثمار: فرص التوسع والتطوير وإعادة التموضع.',
    CONSULT_CTA_EN, CONSULT_CTA_AR),

  // ---- About & contact (top-level pages: the customer is on the main menu, so 8 and 9 work directly)
  {
    key: 'menu_about',
    en: `ℹ️ About QMULATE\n\nQMULATE is a Saudi real estate consultancy, brokerage and property management platform. “${TAGLINE_EN}”\n\nWe serve property owners, families, individuals, businesses and endowments in three areas: Ownership Structuring & Governance, Real Estate Asset Management, and Development & Investment. We work through four stages: Discovery, Structuring, Management and Growth.\n\n📜 Licensing: ${LICENCE_EN}\n\nReply ${keycap(8)} to request a consultation, or write *menu* for the main menu.`,
    ar: `ℹ️ عن QMULATE\n\nQMULATE منصة عقارية سعودية متكاملة تقدم خدمات الاستشارات العقارية والوساطة العقارية وإدارة الأملاك. «${TAGLINE_AR}»\n\nنخدم ملاك العقارات والأسر والأفراد والشركات والأوقاف في ثلاثة مجالات: هيكلة الملكية والحوكمة، وإدارة الأصول العقارية، والتطوير والاستثمار. ونعمل عبر أربع مراحل: الاكتشاف، والهيكلة، والإدارة، والنمو.\n\n📜 التراخيص: ${LICENCE_AR}\n\nأرسل ${keycap(8)} لطلب استشارة، أو اكتب «القائمة» للعودة إلى القائمة الرئيسية.`,
  },
  {
    key: 'menu_contact',
    en: `📍 Contact & Address\n\n{business}\n\nAddress: {address}\nPhone: {phone}\nEmail: {email}\nWebsite: {website}\n\n${RESPONSE_EN}\n\nReply ${keycap(8)} to request a consultation or ${keycap(9)} to talk to our team, or write *menu* for the main menu.`,
    ar: `📍 التواصل والعنوان\n\n{business}\n\nالعنوان: {address}\nالهاتف: {phone}\nالبريد الإلكتروني: {email}\nالموقع الإلكتروني: {website}\nالنسخة العربية: ${SITE_AR}\n\n${RESPONSE_AR}\n\nأرسل ${keycap(8)} لطلب استشارة أو ${keycap(9)} للتحدث مع فريقنا، أو اكتب «القائمة» للعودة إلى القائمة الرئيسية.`,
  },

  // ---- Consultation request (the platform's appointment flow: name, topic, date, time, notes)
  {
    key: 'appointment_intro',
    en: '📅 Request a Consultation\n\nI will ask a few short questions so our team can prepare for your consultation.\n(Reply 0 at any time to return to the main menu)\n\n1️⃣ What is your full name?',
    ar: '📅 طلب استشارة\n\nسأطرح عليك بعض الأسئلة القصيرة ليتمكن فريقنا من الاستعداد لاستشارتك.\n(أرسل 0 في أي وقت للرجوع إلى القائمة الرئيسية)\n\n1️⃣ ما هو اسمك الكريم؟',
  },
  {
    key: 'appointment_step_2',
    en: '2️⃣ Which area would you like to discuss? (Ownership Structuring & Governance, Real Estate Asset Management, Development & Investment, or a general enquiry)',
    ar: '2️⃣ ما المجال الذي ترغب في مناقشته؟ (هيكلة الملكية والحوكمة، أو إدارة الأصول العقارية، أو التطوير والاستثمار، أو استفسار عام)',
  },
  { key: 'appointment_step_3', en: '3️⃣ What date would suit you best for the consultation?', ar: '3️⃣ ما هو التاريخ الأنسب لك للاستشارة؟' },
  {
    key: 'appointment_step_4',
    en: '4️⃣ What time suits you best, and how should we reach you — WhatsApp, phone or email?',
    ar: '4️⃣ ما هو الوقت الأنسب لك، وكيف تفضّل أن نتواصل معك: واتساب أو هاتف أو بريد إلكتروني؟',
  },
  {
    key: 'appointment_step_5',
    en: '5️⃣ Which language do you prefer for the consultation, and is there anything else we should know? (Please do not share confidential documents here. Reply "No" if there is nothing to add):',
    ar: '5️⃣ ما اللغة التي تفضّلها للاستشارة، وهل هناك أي ملاحظات أخرى؟ (يرجى عدم إرسال مستندات سرية هنا، وأرسل «لا» إن لم تكن لديك ملاحظات):',
  },
  {
    key: 'appointment_confirm',
    en: `Thank you. Your consultation request has been received.\n\n📋 Reference: {reference}\n\nOur team will review it and contact you to arrange a time. The consultation is not confirmed until you receive confirmation from our team. ${RESPONSE_EN}\n\nWrite *menu* for the main menu.`,
    ar: `شكراً لك. تم استلام طلب الاستشارة.\n\n📋 الرقم المرجعي: {reference}\n\nسيراجع فريقنا طلبك ويتواصل معك لترتيب موعد. الاستشارة غير مؤكدة حتى يصلك تأكيد من فريقنا. ${RESPONSE_AR}\n\nاكتب «القائمة» للعودة إلى القائمة الرئيسية.`,
  },

  // ---- Consultancy & brokerage inquiry (the platform's quotation flow: name, topic, details) — no prices are ever quoted
  {
    key: 'quotation_intro',
    en: '📋 Consultancy & Brokerage Inquiry\n\nI will ask a few short questions so our team can understand your inquiry.\n(Reply 0 at any time to return to the main menu)\n\n1️⃣ What is your full name?',
    ar: '📋 استفسار عن الاستشارات والوساطة\n\nسأطرح عليك بعض الأسئلة القصيرة ليتمكن فريقنا من فهم استفسارك.\n(أرسل 0 في أي وقت للرجوع إلى القائمة الرئيسية)\n\n1️⃣ ما هو اسمك الكريم؟',
  },
  {
    key: 'quotation_step_2',
    en: '2️⃣ What is your inquiry about? (for example an acquisition, a sale, a development, keeping or exiting a property, or property management)',
    ar: '2️⃣ ما موضوع استفسارك؟ (مثل الشراء أو البيع أو التطوير أو الاحتفاظ بعقار أو الخروج منه أو إدارة الأملاك)',
  },
  {
    key: 'quotation_step_3',
    en: '3️⃣ Please describe it briefly: the type of property, how many properties, and what you would like to achieve. (Please do not share confidential documents here.)',
    ar: '3️⃣ يرجى وصفه باختصار: نوع العقار، وعدد العقارات، وما ترغب في تحقيقه. (يرجى عدم إرسال مستندات سرية هنا)',
  },
  {
    key: 'quotation_confirm',
    en: `✅ Your inquiry has been received.\n\n📋 Reference: {reference}\n\nOur team will review it and contact you. ${RESPONSE_EN}\n\n{business}\nWrite *menu* for the main menu.`,
    ar: `✅ تم استلام استفسارك.\n\n📋 الرقم المرجعي: {reference}\n\nسيراجعه فريقنا ويتواصل معك. ${RESPONSE_AR}\n\n{business}\nاكتب «القائمة» للعودة إلى القائمة الرئيسية.`,
  },

  // ---- Status message when the team confirms a request: no visit or location wording (QMULATE does not publish a map link)
  {
    key: 'request_confirmed',
    en: '✅ Your {kind} request is confirmed\n\n📋 Reference: {reference}\n👤 Name: {name}\n🗂️ Topic: {service}\n📅 Date: {date}\n⏰ Time: {time}\n\nOur team at {business} will be in touch with you.\n\nTo change anything, reply: agent',
    ar: '✅ تم تأكيد طلبك ({kind})\n\n📋 الرقم المرجعي: {reference}\n👤 الاسم: {name}\n🗂️ الموضوع: {service}\n📅 التاريخ: {date}\n⏰ الوقت: {time}\n\nسيتواصل معك فريقنا في {business}.\n\nلأي تعديل أرسل: موظف',
  },
];

// ------------------------------------------------------------------ AI knowledge (the only business knowledge this account's assistant sees)

const BUSINESS_MD = `# ${NAME_EN}

Source: the company's official website (${SITE_EN} and the Arabic pages under ${SITE_AR}), read on 2026-10-10. Only facts stated there are listed. Anything not listed here is unknown: say that our team will confirm it.

## Who we are
- QMULATE is a Saudi real estate consultancy, brokerage and property management platform (Arabic: منصة عقارية متكاملة تقدم خدمات الاستشارات العقارية والوساطة العقارية وإدارة الأملاك).
- Tagline: "${TAGLINE_EN}" (Arabic: ${TAGLINE_AR})
- Clients: property owners, families, individuals, businesses and endowments (Arabic: أوقاف).
- Working stages: Discovery (الاكتشاف), Structuring (الهيكلة), Management (الإدارة), Growth (النمو).
- Values: Integrity, Client Focus, Excellence, Sustainability, Responsibility.

## Licensing (state exactly this, nothing more)
${LICENCE_EN}
Arabic: ${LICENCE_AR}

## Contact (published on the website)
- Address: King Abdulaziz Rd, Albasatin Dist., P.O. Box 23718, Jeddah 9351, Kingdom of Saudi Arabia (Arabic: طريق الملك عبدالعزيز، حي البساتين، ص.ب 23718، جدة 9351، المملكة العربية السعودية)
- Email: ceo@qmulate.com
- Phone: +966 53 333 9052 (the contact number published on the website; this chat is a separate WhatsApp line)
- Website: ${SITE_EN} (Arabic: ${SITE_AR})
- Response time: ${RESPONSE_EN}
- Opening hours: not published. Do not state any.
- No map link is published. Do not invent one.
`;

const SERVICES_MD = `# Services

QMULATE works in three service areas. Each is delivered for corporates, endowments and individuals & families. Describe only what is written here.

## 1. Ownership Structuring & Governance (هيكلة الملكية والحوكمة)
- Corporates: structures ownership and the relationships between shareholders, partners and investors, to set clear authority, support decisions and sustain the business.
- Endowments: governance frameworks that support the endowment's objectives, oversight and continuity across generations.
- Individuals & Families: organises personal assets and investments within a framework for governance, informed decisions and long-term planning.

## 2. Real Estate Asset Management (إدارة الأصول العقارية)
Leasing, operations, maintenance and collections.
- Corporates: portfolio management to protect asset value and improve performance.
- Endowments: operating endowment assets to maximise their benefit and sustainability, in line with the endowment's objectives.
- Individuals & Families: managing personal and investment properties, with visibility of performance and protection of the asset.

## 3. Development & Investment (التطوير والاستثمار)
- Corporates: opportunities for expansion, development and repositioning.
- Endowments: evaluating and developing endowment assets through sustainable investments.
- Individuals & Families: assessing investment opportunities, with consultancy and brokerage for acquisitions, sales, development, retention or exit decisions.

## Consultancy and brokerage (الاستشارات والوساطة العقارية)
Real estate consultancy and brokerage support acquisitions, sales, development, retention or exit decisions.

## How a customer takes the next step
- Main menu option 8: request a consultation (name, area, date, time and contact preference, language and notes).
- Main menu option 4, then 2: send a consultancy or brokerage inquiry.
- Main menu option 9, or writing "agent": talk to the team.
`;

const FAQ_MD = `# Frequently asked questions

**What does QMULATE do?** We are a Saudi real estate consultancy, brokerage and property management platform, with three service areas: ownership structuring & governance, real estate asset management, and development & investment.

**Who do you work with?** Property owners, families, individuals, businesses and endowments.

**Are you licensed?** ${LICENCE_EN}

**Where are you?** King Abdulaziz Rd, Albasatin Dist., P.O. Box 23718, Jeddah 9351, Kingdom of Saudi Arabia.

**How can I contact you?** Email ceo@qmulate.com, phone +966 53 333 9052, or the website ${SITE_EN}. Or use this chat: choose option 8 to request a consultation or option 9 to talk to the team.

**How fast do you reply?** ${RESPONSE_EN}

**Is my information confidential?** Every introduction is treated with complete discretion. Please do not send confidential documents, identity documents or bank details in this chat.

**How do I request a consultation?** Choose option 8 from the main menu (or option 4 inside any service menu) and answer a few short questions. The consultation is not confirmed until the team confirms it.

**What are your fees?** No fee information is available in this chat. Our team can discuss it after understanding the situation.

**Do you have properties for sale or rent?** No property list is available in this chat. Our team can discuss acquisitions, sales and other real estate decisions: send an inquiry (main menu option 4, then 2) or request a consultation.

**What are your opening hours?** Opening hours are not published. The team typically responds within one business day.
`;

const POLICIES_MD = `# How the assistant behaves

You are the WhatsApp assistant of ${NAME_EN}. Be professional, discreet, calm and client-focused. Reply in the customer's language (Arabic or English) and keep answers short.

## Do
- Answer only from this knowledge and the business profile. If something is not stated, say that our team will confirm it.
- Ask one clarifying question at a time when it helps the team: who is asking (an individual or family, a corporate, or an endowment), what kind of property and how many, and what they want to achieve.
- Point to the right next step: option 8 (request a consultation), option 4 then 2 (send an inquiry), or option 9 / "agent" (talk to the team).
- Hand over to the team for anything complex, sensitive, urgent or a complaint, and for any request the menu cannot handle.
- Say clearly when something needs the team's confirmation. A consultation request is not a confirmed appointment.
- Describe the licence exactly as written in the business profile.

## Never
- Give or estimate prices, fees, commissions, rents, yields, returns or valuations, and never promise results or timelines other than "we typically respond within one business day".
- List, describe or invent properties, listings, projects, clients or case studies.
- Give legal, regulatory, tax, financial or Sharia advice, or claim any licence, certification, approval or partnership that is not written in the business profile.
- Ask for or accept confidential documents, identity documents or bank details in the chat.
- Share one customer's information with another.

## Source order
1. The business profile and the menu texts. 2. This knowledge. 3. If neither answers it: the team will confirm.
`;

const AI_KNOWLEDGE_MD = `# Source notes

Official website of ${NAME_EN}: ${SITE_EN} (English) and ${SITE_AR} (Arabic). Pages used: home, about, services, contact. Read on 2026-10-10.

Key statements, as published:
- Tagline: "${TAGLINE_EN}"
- "${LICENCE_EN}"
- "${RESPONSE_EN.split(',')[0]}."
- "Every introduction is treated with complete discretion."

If the website changes, the business profile and menu texts in the dashboard are the authority; update them there.
`;

// ------------------------------------------------------------------ the blueprint

export const QMULATE_BLUEPRINT: BusinessBlueprint = {
  name: NAME_EN,
  nameAr: NAME_AR,
  businessCategory: 'Real estate consultancy, brokerage and property management',
  profile: {
    businessTimezone: 'Asia/Riyadh',
    descriptionEn: `QMULATE is a Saudi real estate consultancy, brokerage and property management platform. It serves property owners, families, individuals, businesses and endowments in three areas: ownership structuring and governance, real estate asset management, and development and investment. “${TAGLINE_EN}”`,
    descriptionAr: `QMULATE منصة عقارية سعودية متكاملة تقدم خدمات الاستشارات العقارية والوساطة العقارية وإدارة الأملاك، وتخدم ملاك العقارات والأسر والأفراد والشركات والأوقاف في هيكلة الملكية والحوكمة، وإدارة الأصول العقارية، والتطوير والاستثمار. «${TAGLINE_AR}»`,
    addressEn: 'King Abdulaziz Rd, Albasatin Dist., P.O. Box 23718, Jeddah 9351, Kingdom of Saudi Arabia',
    addressAr: 'طريق الملك عبدالعزيز، حي البساتين، ص.ب 23718، جدة 9351، المملكة العربية السعودية',
    contactPhone: '+966 53 333 9052',
    contactEmail: 'ceo@qmulate.com',
    supportedLanguages: 'ar,en',
    humanEscalationInfo: 'Complex, sensitive or urgent matters are handled by the QMULATE team. The customer can choose option 9 (Talk to Our Team) or write "agent". The team typically responds within one business day.',
    fallbackMessage: 'Thank you for contacting QMULATE. Please choose an option from the menu (write "menu"), or write "agent" to reach our team.',
  },
  links: [
    { url: SITE_EN, kind: 'website', label: 'QMULATE website' },
    { url: SITE_AR, kind: 'other', label: 'QMULATE website (Arabic)' },
  ],
  menu: QMULATE_MENU,
  templates: TEMPLATES,
  knowledge: {
    'business.md': BUSINESS_MD,
    'services.md': SERVICES_MD,
    'faq.md': FAQ_MD,
    'policies.md': POLICIES_MD,
    'ai-knowledge.md': AI_KNOWLEDGE_MD,
  },
};
