import type { TemplateDefault } from './defaults';
import { TEMPLATE_DEFAULTS } from './defaults';
import { getMenuConfig, menuTemplateKeys, renderMainMenuText, renderSubmenuText, keycap, type MenuItem } from '../automation/menuConfig';

/**
 * Reply templates for every business EXCEPT the original one.
 *
 * The shipped TEMPLATE_DEFAULTS are Rowad Alfa's own words (its name, Jeddah,
 * car audio, PPF…). A second business must never greet its customers with
 * those, so it is seeded from this neutral set instead: the same keys the
 * router and the request workflow need, written without any business facts —
 * names, addresses, hours and contact details are filled from that business's
 * own profile through placeholders and simply disappear while still empty.
 * Menu pages are derived from the business's own menu configuration.
 */

const reuse = (key: string): TemplateDefault => {
  const t = TEMPLATE_DEFAULTS.find((d) => d.key === key);
  if (!t) throw new Error(`shipped template ${key} is missing`);
  return t;
};

const MAIN_FOOTER_AR = `\n\n${keycap(0)} القائمة الرئيسية`;
const MAIN_FOOTER_EN = `\n\n${keycap(0)} Main Menu`;

const LANGUAGE_SELECTION =
  'أهلاً وسهلاً بك في {business_ar}\n\nWelcome to {business_en}\n\nPlease select your preferred language:\nيرجى اختيار اللغة المفضلة:\n\n1️⃣ العربية | Arabic\n2️⃣ English | الإنجليزية\n\nReply with 1 or 2.';

/** Neutral text for an information page whose real content has not been written yet. */
export function defaultInfoText(item: MenuItem, language: 'ar' | 'en'): string {
  const footer = language === 'ar' ? MAIN_FOOTER_AR : MAIN_FOOTER_EN;
  if (item.id === 'about') {
    return language === 'ar' ? `ℹ️ {business}\n\n{description}${footer}` : `ℹ️ {business}\n\n{description}${footer}`;
  }
  if (item.id === 'contact') {
    return language === 'ar'
      ? `📞 تواصل مع {business}\n\nالهاتف: {phone}\nالبريد الإلكتروني: {email}\nالموقع الإلكتروني: {website}${footer}`
      : `📞 Contact {business}\n\nPhone: {phone}\nEmail: {email}\nWebsite: {website}${footer}`;
  }
  if (item.id === 'offerings') {
    return language === 'ar'
      ? `${item.labelAr}\n\nاكتب لنا ما تبحث عنه وسنساعدك، أو اختر "طلب عرض سعر" وسيتواصل معك فريقنا.${footer}`
      : `${item.labelEn}\n\nTell us what you are looking for and we will help, or choose "Request a quotation" and our team will get back to you.${footer}`;
  }
  return language === 'ar'
    ? `${item.labelAr}\n\nللمزيد من التفاصيل اكتب سؤالك، أو اختر خياراً آخر من القائمة.${footer}`
    : `${item.labelEn}\n\nFor details, send us your question or choose another option from the menu.${footer}`;
}

export function genericTemplateDefaults(accountId: number): TemplateDefault[] {
  const { config } = getMenuConfig(accountId);
  const out: TemplateDefault[] = [];

  out.push(
    { key: 'language_selection', category: 'Greeting', titleAr: 'رسالة الترحيب واختيار اللغة', titleEn: 'Welcome & Language Selection', bilingual: true, ar: LANGUAGE_SELECTION, en: LANGUAGE_SELECTION },
    reuse('language_reprompt'),
    { key: 'main_menu', category: 'Main Navigation', titleAr: 'القائمة الرئيسية', titleEn: 'Main Menu', ar: renderMainMenuText(config, 'ar'), en: renderMainMenuText(config, 'en') },
    reuse('invalid_option'),
    reuse('language_switch_prompt'),
    { key: 'language_changed', category: 'Main Navigation', titleAr: 'تأكيد تغيير اللغة', titleEn: 'Language Changed Confirmation', ar: 'تم تغيير اللغة إلى العربية بنجاح', en: 'Language changed to English successfully' },
    reuse('restart_confirmation'),
  );

  // Menu pages (information pages and sub-menu lists) follow the business's own menu.
  for (const { key, item, parent } of menuTemplateKeys(config)) {
    const isList = item.kind === 'submenu';
    out.push({
      key,
      category: 'Business Menu',
      titleAr: parent ? `${parent.labelAr} · ${item.labelAr}` : item.labelAr,
      titleEn: parent ? `${parent.labelEn} · ${item.labelEn}` : item.labelEn,
      ar: isList ? renderSubmenuText(item, 'ar') : defaultInfoText(item, 'ar'),
      en: isList ? renderSubmenuText(item, 'en') : defaultInfoText(item, 'en'),
    });
  }

  out.push(
    {
      key: 'location_hours', category: 'Information', titleAr: 'الموقع وساعات العمل', titleEn: 'Location & Hours',
      ar: `📍 {business}\n\nالموقع: {address}\nرابط الموقع على خرائط جوجل: {maps}\n\n⏰ ساعات العمل:\n{hours}\n\n{notes}${MAIN_FOOTER_AR}`,
      en: `📍 {business}\n\nLocation: {address}\nGoogle Maps: {maps}\n\n⏰ Opening Hours:\n{hours}\n\n{notes}${MAIN_FOOTER_EN}`,
    },
    {
      key: 'prices_offers_list', category: 'Prices & Offers', titleAr: 'العروض الحالية', titleEn: 'Current Offers',
      ar: `🎁 العروض الحالية في {business}:\n\n{offers}${MAIN_FOOTER_AR}`,
      en: `🎁 Current offers at {business}:\n\n{offers}${MAIN_FOOTER_EN}`,
    },
    {
      key: 'prices_offers', category: 'Prices & Offers', titleAr: 'لا توجد عروض حالياً', titleEn: 'No Current Offers',
      ar: `لا توجد عروض معتمدة حالياً في {business}. يمكنك طلب عرض سعر مخصص أو التحدث مع موظف.${MAIN_FOOTER_AR}`,
      en: `There are no current offers at {business} right now. You can request a custom quotation or talk to our team.${MAIN_FOOTER_EN}`,
    },
    {
      key: 'out_of_hours', category: 'Support', titleAr: 'الرد خارج ساعات العمل', titleEn: 'Out-of-hours Reply',
      ar: 'نحن خارج ساعات العمل حالياً. ساعات العمل:\n{hours}\n\nاترك رسالتك وسنرد عليك عند عودتنا.',
      en: 'We are currently closed. Opening hours:\n{hours}\n\nLeave your message and we will reply as soon as we reopen.',
    },

    // ---- Appointment request (name, service, date, time, notes)
    {
      key: 'appointment_intro', category: 'Appointments', titleAr: 'مقدمة حجز الموعد', titleEn: 'Appointment Booking Intro',
      ar: '📅 حجز موعد\n\nسأطرح عليك بعض الأسئلة لإرسال طلب الحجز إلى فريقنا.\n(أرسل 0 في أي وقت للرجوع للقائمة الرئيسية)\n\n1️⃣ ما هو اسمك الكريم؟',
      en: '📅 Book an Appointment\n\nI will ask a few questions to send your appointment request to our team.\n(Reply 0 at any time to return to the main menu)\n\n1️⃣ What is your full name?',
    },
    { key: 'appointment_step_2', category: 'Appointments', titleAr: 'حجز موعد · الخدمة المطلوبة', titleEn: 'Appointment · Service', ar: '2️⃣ ما هي الخدمة المطلوبة؟', en: '2️⃣ Which service do you need?' },
    { key: 'appointment_step_3', category: 'Appointments', titleAr: 'حجز موعد · التاريخ المفضل', titleEn: 'Appointment · Preferred Date', ar: '3️⃣ ما هو التاريخ المفضل لك؟', en: '3️⃣ What is your preferred date?' },
    { key: 'appointment_step_4', category: 'Appointments', titleAr: 'حجز موعد · الوقت المفضل', titleEn: 'Appointment · Preferred Time', ar: '4️⃣ ما هو الوقت المفضل؟', en: '4️⃣ What is your preferred time?' },
    { key: 'appointment_step_5', category: 'Appointments', titleAr: 'حجز موعد · ملاحظات', titleEn: 'Appointment · Notes', ar: '5️⃣ هل لديك أي ملاحظات أو طلبات خاصة؟ (أرسل "لا" في حال عدم وجود ملاحظات):', en: '5️⃣ Any additional notes or special requests? (Reply "No" if none):' },
    {
      key: 'appointment_confirm', category: 'Appointments', titleAr: 'تأكيد استلام طلب الحجز', titleEn: 'Appointment Received Confirmation',
      ar: `شكراً لك. تم استلام طلب الحجز الخاص بك.\n\n📋 الرقم المرجعي: {reference}\n\nسيقوم فريقنا بمراجعة التوفر والتواصل معك لتأكيد الموعد.\n\nالموعد غير مؤكد حتى يصلك تأكيد رسمي من الفريق.${MAIN_FOOTER_AR}`,
      en: `Thank you. Your appointment request has been received.\n\n📋 Reference: {reference}\n\nOur team will check availability and contact you to confirm the appointment.\n\nThe appointment is not confirmed until you receive confirmation from our team.${MAIN_FOOTER_EN}`,
    },

    // ---- Quotation request (name, service, details)
    {
      key: 'quotation_intro', category: 'Quotation', titleAr: 'طلب عرض سعر · مقدمة', titleEn: 'Custom Quotation · Intro',
      ar: '📋 طلب عرض سعر\n\nسأطرح عليك بعض الأسئلة لإعداد عرض السعر.\n(أرسل 0 في أي وقت للرجوع للقائمة الرئيسية)\n\n1️⃣ ما هو اسمك الكريم؟',
      en: '📋 Quotation Request\n\nI will ask a few questions to prepare your quotation.\n(Reply 0 at any time to return to the main menu)\n\n1️⃣ What is your full name?',
    },
    { key: 'quotation_step_2', category: 'Quotation', titleAr: 'طلب عرض سعر · الخدمة أو المنتج', titleEn: 'Custom Quotation · Service or Product', ar: '2️⃣ ما هي الخدمة أو المنتج المطلوب؟', en: '2️⃣ Which service or product do you need?' },
    { key: 'quotation_step_3', category: 'Quotation', titleAr: 'طلب عرض سعر · التفاصيل', titleEn: 'Custom Quotation · Details', ar: '3️⃣ اذكر أي تفاصيل إضافية (الكمية، المقاسات، الموعد المطلوب…):', en: '3️⃣ Add any further details (quantity, sizes, when you need it…):' },
    {
      key: 'quotation_confirm', category: 'Quotation', titleAr: 'تأكيد استلام طلب عرض السعر', titleEn: 'Quotation Received Confirmation',
      ar: `✅ تم استلام طلب عرض السعر بنجاح!\n\n📋 الرقم المرجعي: {reference}\nسيتواصل معك فريقنا لتأكيد السعر الرسمي.\n\n{business}${MAIN_FOOTER_AR}`,
      en: `✅ Quotation request received successfully!\n\n📋 Reference: {reference}\nOur team will contact you with the official price.\n\n{business}${MAIN_FOOTER_EN}`,
    },

    // ---- Request status (customer)
    {
      key: 'request_confirmed', category: 'Request Status', titleAr: 'تأكيد الموعد / الطلب', titleEn: 'Request Confirmed',
      ar: '✅ تم تأكيد طلبك ({kind})\n\n📋 الرقم المرجعي: {reference}\n👤 الاسم: {name}\n🔧 الخدمة: {service}\n📅 التاريخ: {date}\n⏰ الوقت: {time}\n\nنرحب بك في {business}.\n📍 الموقع: {maps}\n\nلأي تعديل أرسل: موظف',
      en: '✅ Your {kind} request is confirmed\n\n📋 Reference: {reference}\n👤 Name: {name}\n🔧 Service: {service}\n📅 Date: {date}\n⏰ Time: {time}\n\nWe look forward to welcoming you at {business}.\n📍 Location: {maps}\n\nTo change anything, reply: agent',
    },
    {
      key: 'request_rejected', category: 'Request Status', titleAr: 'رفض الطلب', titleEn: 'Request Rejected',
      ar: '❌ نعتذر، لم نتمكن من قبول طلبك ({kind}) رقم {reference} في الوقت المطلوب.\n\nيمكنك إرسال طلب جديد من القائمة (أرسل 0) أو التحدث مع موظف بإرسال: موظف\n\n{business}',
      en: '❌ Sorry, we could not accept your {kind} request {reference} for the requested time.\n\nYou can send a new request from the menu (reply 0) or reply: agent to talk to our team.\n\n{business}',
    },
    {
      key: 'request_cancelled', category: 'Request Status', titleAr: 'إلغاء الطلب', titleEn: 'Request Cancelled',
      ar: '🚫 تم إلغاء طلبك ({kind}) رقم {reference}.\n\nإذا كان ذلك عن طريق الخطأ، أرسل 0 للقائمة أو تحدث مع موظف بإرسال: موظف\n\n{business}',
      en: '🚫 Your {kind} request {reference} has been cancelled.\n\nIf this was a mistake, reply 0 for the menu or reply: agent to talk to our team.\n\n{business}',
    },
    reuse('request_status_update'),
    reuse('staff_new_request'),
    reuse('staff_status_changed'),
    reuse('human_support'),
    reuse('unsupported_message'),
    reuse('fallback_error'),
    reuse('ai_disabled'),
  );
  return out;
}
