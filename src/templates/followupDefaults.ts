/**
 * Reply templates of the after-hours experience and the customer follow-up requests (callback / staff WhatsApp message), shared by
 * EVERY business (the original one and the generic ones alike): the texts carry no business facts — hours, next opening, phone, the
 * appointment types and the customer's choices are filled from that business's own settings and the conversation through placeholders.
 * Editable per business in the Manual Reply Editor like every other template.
 *
 * Placeholders used here: {business} {hours} {next_open} {phone} {types} {type} {method} {when} {window} {reference} {requests} {promise} {name}
 */

interface FollowupTemplateDefault {
  key: string;
  category: string;
  titleAr: string;
  titleEn: string;
  bilingual?: boolean;
  ar: string;
  en: string;
}

const CAT = 'After-hours & Follow-up';

export const FOLLOWUP_TEMPLATE_KEYS = [
  'after_hours_notice', 'followup_menu', 'followup_menu_open', 'followup_method_prompt', 'followup_type_prompt', 'followup_time_prompt', 'followup_time_invalid',
  'followup_time_closed', 'followup_confirm_scheduled', 'followup_confirm_asap_open', 'followup_confirm_asap_closed', 'followup_confirm_whatsapp',
  'followup_cancel_list', 'followup_cancel_none', 'followup_cancelled', 'followup_save_failed', 'followup_direct_call', 'followup_invalid_option',
  'followup_staff_alert', 'followup_staff_reminder', 'followup_staff_overdue', 'followup_staff_eligible',
] as const;

export const FOLLOWUP_TEMPLATES: FollowupTemplateDefault[] = [
  {
    key: 'after_hours_notice', category: CAT, titleAr: 'إشعار خارج ساعات العمل', titleEn: 'After-hours Notice',
    ar: '🕒 {business} مغلق حالياً.\n\n⏰ ساعات العمل:\n{hours}\n\nسنعود {next_open}.\n{promise}',
    en: '🕒 {business} is currently closed.\n\n⏰ Opening hours:\n{hours}\n\nWe will be back {next_open}.\n{promise}',
  },
  {
    key: 'followup_menu', category: CAT, titleAr: 'خيارات المتابعة (مغلق)', titleEn: 'Follow-up Choices (closed)',
    ar: 'كيف تحب أن نتابع معك؟\n\n1️⃣ طلب اتصال هاتفي\n2️⃣ طلب رسالة واتساب من الموظفين\n3️⃣ التواصل معي فور توفر الموظفين\n4️⃣ اختيار وقت للاتصال/الموعد\n5️⃣ الموقع والعروض والخدمات\n6️⃣ إلغاء طلب قائم\n\nأرسل رقم الخيار، أو اكتب سؤالك مباشرةً وسيجيبك المساعد الآن.\n0️⃣ القائمة الرئيسية',
    en: 'How would you like us to follow up?\n\n1️⃣ Request a phone callback\n2️⃣ Request a WhatsApp message from staff\n3️⃣ Contact me as soon as staff are available\n4️⃣ Choose a callback / appointment time\n5️⃣ Location, offers and services\n6️⃣ Cancel an existing request\n\nReply with the option number, or just type your question and the assistant will answer now.\n0️⃣ Main Menu',
  },
  {
    key: 'followup_menu_open', category: CAT, titleAr: 'خيارات المتابعة (مفتوح)', titleEn: 'Follow-up Choices (open)',
    ar: 'كيف تحب أن نتابع معك؟\n\n1️⃣ طلب اتصال هاتفي\n2️⃣ طلب رسالة واتساب من الموظفين\n3️⃣ التواصل معي في أقرب وقت\n4️⃣ اختيار وقت للاتصال/الموعد\n5️⃣ الموقع والعروض والخدمات\n6️⃣ إلغاء طلب قائم\n7️⃣ الاتصال بنا الآن: {phone}\n\nأرسل رقم الخيار.\n0️⃣ القائمة الرئيسية',
    en: 'How would you like us to follow up?\n\n1️⃣ Request a phone callback\n2️⃣ Request a WhatsApp message from staff\n3️⃣ Contact me as soon as possible\n4️⃣ Choose a callback / appointment time\n5️⃣ Location, offers and services\n6️⃣ Cancel an existing request\n7️⃣ Call us now: {phone}\n\nReply with the option number.\n0️⃣ Main Menu',
  },
  {
    key: 'followup_method_prompt', category: CAT, titleAr: 'اختيار طريقة التواصل', titleEn: 'Contact Method Prompt',
    ar: 'كيف تفضل أن نتواصل معك؟\n\n1️⃣ اتصال هاتفي\n2️⃣ رسالة واتساب\n\n0️⃣ رجوع',
    en: 'How should we contact you?\n\n1️⃣ Phone call\n2️⃣ WhatsApp message\n\n0️⃣ Back',
  },
  {
    key: 'followup_type_prompt', category: CAT, titleAr: 'اختيار نوع الموعد', titleEn: 'Appointment Type Prompt',
    ar: 'ما موضوع التواصل؟\n\n{types}\n\nأرسل رقم الخيار.\n0️⃣ رجوع',
    en: 'What is it about?\n\n{types}\n\nReply with the option number.\n0️⃣ Back',
  },
  {
    key: 'followup_time_prompt', category: CAT, titleAr: 'طلب وقت التواصل', titleEn: 'Time Prompt',
    ar: 'متى يناسبك؟ اكتب اليوم والوقت، مثلاً: "غداً 10 صباحاً" أو "الأحد 5 مساءً" أو "2026-10-20 17:30".\n\n⏰ ساعات العمل:\n{hours}\n\n0️⃣ رجوع',
    en: 'When suits you? Send the day and time, for example "tomorrow 10am", "Sunday 5pm" or "2026-10-20 17:30".\n\n⏰ Opening hours:\n{hours}\n\n0️⃣ Back',
  },
  {
    key: 'followup_time_invalid', category: CAT, titleAr: 'وقت غير مفهوم', titleEn: 'Time Not Understood',
    ar: 'لم أفهم الوقت. اكتب اليوم والوقت مثل "غداً 10 صباحاً" أو "2026-10-20 17:30" (أو 0 للرجوع).',
    en: 'I could not read that time. Please send the day and time like "tomorrow 10am" or "2026-10-20 17:30" (or 0 to go back).',
  },
  {
    key: 'followup_time_closed', category: CAT, titleAr: 'وقت خارج ساعات العمل', titleEn: 'Time Outside Opening Hours',
    ar: 'الوقت {when} خارج ساعات العمل. أقرب فتح: {next_open}.\n\n⏰ ساعات العمل:\n{hours}\n\nاختر وقتاً آخر، أو أرسل 0 للرجوع.',
    en: '{when} is outside our opening hours. The next opening is {next_open}.\n\n⏰ Opening hours:\n{hours}\n\nPlease choose another time, or reply 0 to go back.',
  },
  {
    key: 'followup_confirm_scheduled', category: CAT, titleAr: 'تأكيد طلب الاتصال بوقت محدد', titleEn: 'Scheduled Request Confirmation',
    ar: '✅ تم حفظ طلبك.\n\n📋 الرقم المرجعي: {reference}\n📌 الموضوع: {type}\n📞 الطريقة: {method}\n🕒 الوقت: {when}\n\nسيتواصل معك فريقنا في الوقت المتفق عليه (خلال {window}). لإلغاء الطلب أرسل "إلغاء".',
    en: '✅ Your request is saved.\n\n📋 Reference: {reference}\n📌 About: {type}\n📞 Method: {method}\n🕒 Time: {when}\n\nOur team will contact you at the agreed time (within {window}). To cancel, reply "cancel".',
  },
  {
    key: 'followup_confirm_asap_open', category: CAT, titleAr: 'تأكيد طلب التواصل (مفتوح)', titleEn: 'ASAP Confirmation (open)',
    ar: '✅ تم حفظ طلبك وإبلاغ الفريق.\n\n📋 الرقم المرجعي: {reference}\n📌 الموضوع: {type}\n📞 الطريقة: {method}\n\nسيتواصل معك أحد الموظفين في أقرب وقت ممكن. {promise}\nلإلغاء الطلب أرسل "إلغاء".',
    en: '✅ Your request is saved and the team has been notified.\n\n📋 Reference: {reference}\n📌 About: {type}\n📞 Method: {method}\n\nA member of staff will contact you as soon as possible. {promise}\nTo cancel, reply "cancel".',
  },
  {
    key: 'followup_confirm_asap_closed', category: CAT, titleAr: 'تأكيد طلب التواصل (مغلق)', titleEn: 'ASAP Confirmation (closed)',
    ar: '✅ تم حفظ طلبك.\n\n📋 الرقم المرجعي: {reference}\n📌 الموضوع: {type}\n📞 الطريقة: {method}\n\nالموظفون غير متاحين حالياً؛ سيتواصلون معك بعد عودتنا {next_open}. {promise}\nلإلغاء الطلب أرسل "إلغاء".',
    en: '✅ Your request is saved.\n\n📋 Reference: {reference}\n📌 About: {type}\n📞 Method: {method}\n\nStaff are not available right now; they will contact you after we reopen {next_open}. {promise}\nTo cancel, reply "cancel".',
  },
  {
    key: 'followup_confirm_whatsapp', category: CAT, titleAr: 'تأكيد طلب رسالة واتساب', titleEn: 'WhatsApp Message Requested',
    ar: 'تم تسجيل طلب رسالة واتساب من الموظفين (لم تُرسل بعد). سيكتب لك أحد الموظفين هنا {when}.',
    en: 'A WhatsApp message from our staff has been requested (not sent yet). A member of staff will write to you here {when}.',
  },
  {
    key: 'followup_cancel_list', category: CAT, titleAr: 'قائمة الطلبات للإلغاء', titleEn: 'Cancel Request List',
    ar: 'طلباتك القائمة:\n\n{requests}\n\nأرسل رقم الطلب الذي تريد إلغاءه، أو 0 للرجوع.',
    en: 'Your open requests:\n\n{requests}\n\nReply with the number of the request to cancel, or 0 to go back.',
  },
  {
    key: 'followup_cancel_none', category: CAT, titleAr: 'لا توجد طلبات قائمة', titleEn: 'No Open Requests',
    ar: 'لا توجد لديك طلبات اتصال أو مواعيد قائمة.\n\n0️⃣ القائمة الرئيسية',
    en: 'You have no open callback or appointment requests.\n\n0️⃣ Main Menu',
  },
  {
    key: 'followup_cancelled', category: CAT, titleAr: 'تأكيد الإلغاء', titleEn: 'Cancellation Confirmed',
    ar: '✅ تم إلغاء الطلب {reference} وإيقاف التذكيرات المرتبطة به.\n\n0️⃣ القائمة الرئيسية',
    en: '✅ Request {reference} has been cancelled and its reminders stopped.\n\n0️⃣ Main Menu',
  },
  {
    key: 'followup_save_failed', category: CAT, titleAr: 'تعذر حفظ الطلب', titleEn: 'Request Could Not Be Saved',
    ar: '⚠️ عذراً، تعذر حفظ طلبك الآن. يرجى المحاولة مرة أخرى بعد قليل، أو التواصل معنا على {phone}.',
    en: '⚠️ Sorry, your request could not be saved right now. Please try again in a moment, or contact us on {phone}.',
  },
  {
    key: 'followup_direct_call', category: CAT, titleAr: 'الاتصال المباشر', titleEn: 'Direct Call',
    ar: '📞 نحن متاحون الآن. يمكنك الاتصال بنا مباشرةً على {phone} حتى {when}.\n\n0️⃣ القائمة الرئيسية',
    en: '📞 We are open now. You can call us directly on {phone} until {when}.\n\n0️⃣ Main Menu',
  },
  {
    key: 'followup_invalid_option', category: CAT, titleAr: 'خيار متابعة غير صحيح', titleEn: 'Invalid Follow-up Option',
    ar: 'يرجى إرسال رقم من الخيارات المعروضة، أو 0 للرجوع.',
    en: 'Please reply with one of the listed numbers, or 0 to go back.',
  },
  // ---- what STAFF receive on WhatsApp (the dashboard notification is built from the same facts)
  {
    key: 'followup_staff_alert', category: CAT, titleAr: 'تنبيه الموظفين: طلب متابعة جديد', titleEn: 'Staff Alert: New Follow-up Request',
    bilingual: true,
    ar: '🔔 طلب متابعة جديد — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n🕒 {when}\n📋 {reference}\n{details}',
    en: '🔔 New follow-up request — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n🕒 {when}\n📋 {reference}\n{details}',
  },
  {
    key: 'followup_staff_reminder', category: CAT, titleAr: 'تذكير الموظفين بالموعد', titleEn: 'Staff Reminder',
    bilingual: true,
    ar: '⏰ حان وقت التواصل — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n🕒 {when}\n📋 {reference}\n{details}',
    en: '⏰ Time to contact the customer — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n🕒 {when}\n📋 {reference}\n{details}',
  },
  {
    key: 'followup_staff_overdue', category: CAT, titleAr: 'تنبيه الموظفين: طلب متأخر', titleEn: 'Staff Alert: Overdue',
    bilingual: true,
    ar: '⚠️ طلب متابعة متأخر — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n🕒 كان مقرراً {when}\n📋 {reference}\nيرجى إعادة الجدولة أو تسجيل النتيجة من لوحة التحكم.',
    en: '⚠️ Overdue follow-up — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n🕒 was due {when}\n📋 {reference}\nPlease reschedule or record the outcome in the dashboard.',
  },
  {
    key: 'followup_staff_eligible', category: CAT, titleAr: 'تنبيه الموظفين: طلب جاهز للتنفيذ', titleEn: 'Staff Alert: Request Ready',
    bilingual: true,
    ar: '🟢 طلب متابعة بانتظارك الآن — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n📋 {reference}\n{details}',
    en: '🟢 A follow-up request is ready for you — {business}\n\n{customer}\n📌 {type}\n📞 {method}\n📋 {reference}\n{details}',
  },
];
