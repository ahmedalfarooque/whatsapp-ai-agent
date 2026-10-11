import type { TemplateDefault } from './defaults';

/**
 * Customer-facing text of the Inquiry Cart and of the quotation lifecycle. ONE set shared by every business: it contains no business
 * facts (names, products, prices), only the wording of the steps, so the original business and any business added later start with
 * the same editable replies (Manual Reply Editor). Placeholders: {details} the cart / status text built from the customer's own
 * records, {reference} the request or quotation reference, {kind} {status} the request type and its current status.
 */
const FOOT_EN = '\n\n0️⃣ Main Menu';
const FOOT_AR = '\n\n0️⃣ القائمة الرئيسية';

export const CART_TEMPLATES: TemplateDefault[] = [
  {
    key: 'cart_menu', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات', titleEn: 'Inquiry Cart',
    ar: `🛒 سلة الاستفسارات\n\n{details}\n\n1️⃣ إضافة عنصر\n2️⃣ حذف عنصر\n3️⃣ مراجعة وإرسال الاستفسار\n4️⃣ استفساراتي وحالة عروض الأسعار${FOOT_AR}`,
    en: `🛒 Inquiry Cart\n\n{details}\n\n1️⃣ Add an item\n2️⃣ Remove an item\n3️⃣ Review & submit your inquiry\n4️⃣ My inquiries & quotation status${FOOT_EN}`,
  },
  {
    key: 'cart_add_prompt', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · إضافة عنصر', titleEn: 'Inquiry Cart · Add an Item',
    ar: `ما الذي تود الاستفسار عنه؟ اكتب المنتج أو الخدمة مع أي تفاصيل (المقاس، الموديل، اللون…) في رسالة واحدة.${FOOT_AR}`,
    en: `What would you like to ask about? Write the product or service with any details (size, model, colour…) in one message.${FOOT_EN}`,
  },
  {
    key: 'cart_qty_prompt', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · الكمية', titleEn: 'Inquiry Cart · Quantity',
    ar: 'كم الكمية المطلوبة؟ أرسل رقماً، أو أرسل "تخطي" إذا لم تحددها بعد.',
    en: 'How many do you need? Send a number, or send "skip" if you have not decided yet.',
  },
  {
    key: 'cart_item_added', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · تمت الإضافة', titleEn: 'Inquiry Cart · Item Added',
    ar: '✅ تمت إضافة العنصر إلى سلتك.', en: '✅ Added to your inquiry cart.',
  },
  {
    key: 'cart_remove_prompt', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · حذف عنصر', titleEn: 'Inquiry Cart · Remove an Item',
    ar: `أرسل رقم العنصر الذي تريد حذفه:\n\n{details}${FOOT_AR}`, en: `Send the number of the item to remove:\n\n{details}${FOOT_EN}`,
  },
  {
    key: 'cart_item_removed', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · تم الحذف', titleEn: 'Inquiry Cart · Item Removed',
    ar: '🗑️ تم حذف العنصر من سلتك.', en: '🗑️ Removed from your inquiry cart.',
  },
  {
    key: 'cart_review', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · المراجعة', titleEn: 'Inquiry Cart · Review',
    ar: `📋 مراجعة استفسارك\n\n{details}\n\n1️⃣ إرسال الاستفسار إلى فريقنا\n2️⃣ متابعة التعديل${FOOT_AR}`,
    en: `📋 Review your inquiry\n\n{details}\n\n1️⃣ Send the inquiry to our team\n2️⃣ Keep editing${FOOT_EN}`,
  },
  {
    key: 'cart_general_prompt', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · استفسار عام', titleEn: 'Inquiry Cart · General Inquiry',
    ar: `سلتك فارغة. اكتب استفسارك في رسالة واحدة وسيراجعه فريقنا.${FOOT_AR}`,
    en: `Your cart is empty. Write your inquiry in one message and our team will review it.${FOOT_EN}`,
  },
  {
    key: 'cart_submitted', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · تم الإرسال', titleEn: 'Inquiry Cart · Submitted',
    ar: `✅ تم إرسال استفسارك إلى فريقنا.\n\n📋 الرقم المرجعي: {reference}\n\n{details}\n\nيمكنك متابعة الحالة في أي وقت من: سلة الاستفسارات ← استفساراتي.${FOOT_AR}`,
    en: `✅ Your inquiry has been sent to our team.\n\n📋 Reference: {reference}\n\n{details}\n\nYou can check its status at any time from: Inquiry Cart → My inquiries.${FOOT_EN}`,
  },
  {
    key: 'cart_invalid_input', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · إدخال غير صحيح', titleEn: 'Inquiry Cart · Invalid Input',
    ar: '⚠️ لم أفهم ذلك. يرجى اتباع الخيارات الظاهرة، أو أرسل 0 للعودة إلى القائمة الرئيسية.',
    en: '⚠️ I did not understand that. Please follow the options shown, or send 0 to return to the main menu.',
  },
  {
    key: 'cart_full', category: 'Inquiry Cart', titleAr: 'سلة الاستفسارات · السلة ممتلئة', titleEn: 'Inquiry Cart · Cart Full',
    ar: '⚠️ وصلت سلتك إلى الحد الأقصى للعناصر. أرسل الاستفسار أو احذف عنصراً أولاً.',
    en: '⚠️ Your cart has reached its maximum number of items. Send the inquiry or remove an item first.',
  },
  {
    key: 'cart_status_list', category: 'Inquiry Cart', titleAr: 'استفساراتي', titleEn: 'My Inquiries & Quotations',
    ar: `📋 استفساراتك وعروض الأسعار\n\n{details}\n\nأرسل الرقم المرجعي (مثل INQ-2026-1234) لعرض التفاصيل.${FOOT_AR}`,
    en: `📋 Your inquiries and quotations\n\n{details}\n\nSend a reference number (for example INQ-2026-1234) to see the details.${FOOT_EN}`,
  },
  {
    key: 'cart_status_none', category: 'Inquiry Cart', titleAr: 'لا توجد استفسارات', titleEn: 'No Inquiries Yet',
    ar: `لا توجد لديك استفسارات أو عروض أسعار مسجّلة بعد. يمكنك إضافة عناصر إلى السلة وإرسالها من القائمة السابقة.${FOOT_AR}`,
    en: `You have no inquiries or quotations on record yet. You can add items to your cart and send them from the previous menu.${FOOT_EN}`,
  },
  {
    key: 'cart_status_detail', category: 'Inquiry Cart', titleAr: 'تفاصيل الاستفسار', titleEn: 'Inquiry Status Detail',
    ar: `📋 {reference}\nالنوع: {kind}\nالحالة: {status}\n\n{details}${FOOT_AR}`,
    en: `📋 {reference}\nType: {kind}\nStatus: {status}\n\n{details}${FOOT_EN}`,
  },
  {
    key: 'cart_status_not_found', category: 'Inquiry Cart', titleAr: 'المرجع غير موجود', titleEn: 'Reference Not Found',
    ar: `لم نجد هذا الرقم المرجعي ضمن استفساراتك. تأكد من الرقم أو أرسل 0 للقائمة الرئيسية، أو اكتب "موظف" للتحدث مع فريقنا.`,
    en: `We could not find that reference among your inquiries. Check the number, send 0 for the main menu, or reply "human" to talk to our team.`,
  },
  // ---- Quotation lifecycle (customer notifications; each goes out at most once per quotation and status)
  {
    key: 'quotation_approved', category: 'Request Status', titleAr: 'الموافقة على عرض السعر', titleEn: 'Quotation Approved',
    ar: '✅ تمت الموافقة على عرض السعر رقم {reference}.\n\nسيصلك العرض الرسمي هنا قريباً.\n\n{business}',
    en: '✅ Your quotation {reference} has been approved.\n\nWe will send you the official quotation here shortly.\n\n{business}',
  },
  {
    key: 'quotation_rejected', category: 'Request Status', titleAr: 'عدم اعتماد عرض السعر', titleEn: 'Quotation Not Approved',
    ar: '❌ نعتذر، لم يتم اعتماد طلب عرض السعر رقم {reference}.\n\nيرجى التواصل مع فريقنا لمزيد من المساعدة (اكتب: موظف).\n\n{business}',
    en: '❌ Sorry, your quotation request {reference} was not approved.\n\nPlease contact our team for further assistance (reply: human).\n\n{business}',
  },
  {
    key: 'quotation_delivery', category: 'Request Status', titleAr: 'إرسال عرض السعر', titleEn: 'Quotation Delivery',
    ar: '📄 عرض السعر رقم {reference}\n\n{details}\n\n{business}',
    en: '📄 Quotation {reference}\n\n{details}\n\n{business}',
  },
];
