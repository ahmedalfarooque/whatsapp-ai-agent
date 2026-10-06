// Shipped reply templates — the customer-facing WhatsApp content for Rowad Alfa
// Auto Care, ported from the original Antigravity implementation
// (config.json reply_templates + the submenu detail texts in its router).
//
// These seed the default_* and live_* columns of reply_templates on first boot
// and back "Reset to Default". Whatever text is live here is exactly what the
// customer receives: the sender adds nothing (no generated option lists, no
// footers). Option NUMBERS are part of the text; which action each number
// triggers is fixed in src/automation/menuRouter.ts.
//
// Zero-fabricated-pricing rule: no numeric prices anywhere. Price options
// direct the customer to share vehicle details for a confirmed quote.
//
// Placeholders: {name} customer display name (may be empty), {business}
// business name (Arabic name for Arabic messages when set), {maps} Google Maps
// link, {hours} published opening hours, {address} published address,
// {offers} currently customer-visible offers, {reference} request reference.
export interface TemplateDefault {
  key: string;
  category: string;
  titleAr: string;
  titleEn: string;
  ar: string;
  en: string;
  /** Bilingual templates show the same text regardless of the customer's language. */
  bilingual?: boolean;
}

import { DEFAULT_GOOGLE_MAPS_URL } from '../config/businessSettings';

/** Confirmed Google Maps link (the dashboard Location page can override it; templates use {maps}). */
export const GOOGLE_MAPS_LINK = DEFAULT_GOOGLE_MAPS_URL;

const MAIN_MENU_FOOTER_AR = '\n\n0️⃣ القائمة الرئيسية';
const MAIN_MENU_FOOTER_EN = '\n\n0️⃣ Main Menu';

function detail(
  key: string,
  titleAr: string,
  titleEn: string,
  ar: string,
  en: string,
): TemplateDefault {
  return { key, category: 'Service Details', titleAr, titleEn, ar: ar + MAIN_MENU_FOOTER_AR, en: en + MAIN_MENU_FOOTER_EN };
}

const LANGUAGE_SELECTION =
  '🚗 أهلاً وسهلاً بك في رواد ألفا للعناية بالسيارات\n\nWelcome to Rowad Alfa Auto Care 🚗\n\nنسعد بخدمتك وتقديم أفضل الحلول لسيارتك.\n\nWe are happy to assist you with our automotive products and services.\n\nPlease select your preferred language:\n\nيرجى اختيار اللغة المفضلة:\n\n1️⃣ العربية | Arabic\n2️⃣ English | الإنجليزية\n\nReply with 1 or 2.';

const LANGUAGE_REPROMPT = 'يرجى الرد بالرقم 1 للعربية أو 2 للإنجليزية.\n\nPlease reply with 1 for Arabic or 2 for English.';

const LANGUAGE_SWITCH_PROMPT =
  '🌐 يرجى اختيار اللغة المفضلة / Please select your preferred language:\n\n1️⃣ العربية | Arabic\n2️⃣ English | الإنجليزية\n\n(أرسل 1 أو 2 | Reply with 1 or 2)';

const RESTART_CONFIRMATION = "Done — I've started a fresh conversation. / تم — بدأنا محادثة جديدة.";

const UNSUPPORTED =
  'I can currently only read text messages — could you send that as text? / أستطيع قراءة الرسائل النصية فقط حالياً، يرجى إرسالها كنص.';

export const TEMPLATE_DEFAULTS: TemplateDefault[] = [
  // ------------------------------------------------------------------ Greeting
  {
    key: 'language_selection',
    category: 'Greeting',
    titleAr: 'رسالة الترحيب واختيار اللغة',
    titleEn: 'Welcome & Language Selection',
    bilingual: true,
    ar: LANGUAGE_SELECTION,
    en: LANGUAGE_SELECTION,
  },
  {
    key: 'language_reprompt',
    category: 'Greeting',
    titleAr: 'إعادة طلب اختيار اللغة',
    titleEn: 'Language Re-prompt',
    bilingual: true,
    ar: LANGUAGE_REPROMPT,
    en: LANGUAGE_REPROMPT,
  },

  // ------------------------------------------------------------ Main Navigation
  {
    key: 'main_menu',
    category: 'Main Navigation',
    titleAr: 'القائمة الرئيسية',
    titleEn: 'Main Menu',
    ar: 'أهلاً بك في رواد ألفا للعناية بالسيارات 🚗\n\nكيف يمكننا خدمتك اليوم؟\n\n1️⃣ صوتيات السيارات\n2️⃣ إكسسوارات السيارات\n3️⃣ العناية بالسيارات\n4️⃣ التظليل والحماية\n5️⃣ الأسعار والعروض\n6️⃣ الموقع وساعات العمل\n7️⃣ حجز موعد\n8️⃣ التحدث مع موظف\n9️⃣ معلومات عن رواد ألفا\n\nأرسل رقم الخيار.',
    en: 'Welcome to Rowad Alfa Auto Care 🚗\n\nHow can we help you today?\n\n1️⃣ Car Audio\n2️⃣ Car Accessories\n3️⃣ Car Care\n4️⃣ Tinting & Protection\n5️⃣ Prices & Offers\n6️⃣ Location & Opening Hours\n7️⃣ Book an Appointment\n8️⃣ Talk to Staff\n9️⃣ About Rowad Alfa\n\nPlease reply with the option number.',
  },
  {
    key: 'invalid_option',
    category: 'Main Navigation',
    titleAr: 'خيار غير صحيح',
    titleEn: 'Invalid Option',
    ar: '⚠️ خيار غير صحيح. يرجى اختيار رقم من القائمة التالية:',
    en: '⚠️ Invalid choice. Please select an option from the menu:',
  },
  {
    key: 'language_switch_prompt',
    category: 'Main Navigation',
    titleAr: 'طلب تغيير اللغة',
    titleEn: 'Language Switch Prompt',
    bilingual: true,
    ar: LANGUAGE_SWITCH_PROMPT,
    en: LANGUAGE_SWITCH_PROMPT,
  },
  {
    key: 'language_changed',
    category: 'Main Navigation',
    titleAr: 'تأكيد تغيير اللغة',
    titleEn: 'Language Changed Confirmation',
    ar: 'تم تغيير اللغة إلى العربية بنجاح 🇸🇦',
    en: 'Language changed to English successfully 🌐',
  },
  {
    key: 'restart_confirmation',
    category: 'Main Navigation',
    titleAr: 'تأكيد إعادة البدء',
    titleEn: 'Restart Confirmation',
    bilingual: true,
    ar: RESTART_CONFIRMATION,
    en: RESTART_CONFIRMATION,
  },

  // ------------------------------------------------------------------ Services
  {
    key: 'car_audio',
    category: 'Services',
    titleAr: 'قائمة صوتيات السيارات',
    titleEn: 'Car Audio Menu',
    ar: '🔊 صوتيات السيارات\n\nاختر الخدمة المطلوبة:\n\n1️⃣ أنظمة صوتية كاملة\n2️⃣ شاشات السيارات (أندرويد وآبل كاربلاي)\n3️⃣ سماعات السيارات\n4️⃣ مضخمات الصوت (Amplifiers)\n5️⃣ ساب ووفر (Subwoofers)\n6️⃣ تحسين وترقية الصوت\n7️⃣ استفسار عن الأسعار\n0️⃣ القائمة الرئيسية',
    en: '🔊 Car Audio\n\nPlease select a service:\n\n1️⃣ Complete Sound System\n2️⃣ Android Screens & Displays\n3️⃣ Car Speakers\n4️⃣ Amplifiers\n5️⃣ Subwoofers\n6️⃣ Sound Upgrade\n7️⃣ Price Enquiry\n0️⃣ Main Menu',
  },
  {
    key: 'car_accessories',
    category: 'Services',
    titleAr: 'قائمة إكسسوارات السيارات',
    titleEn: 'Car Accessories Menu',
    ar: '🛠️ إكسسوارات السيارات\n\n1️⃣ إكسسوارات داخلية\n2️⃣ إكسسوارات خارجية\n3️⃣ إضاءة السيارات وLED\n4️⃣ كاميرات وحساسات ركن\n5️⃣ إكسسوارات عملية وتقنية\n6️⃣ الاستفسار عن منتج\n0️⃣ القائمة الرئيسية',
    en: '🛠️ Car Accessories\n\n1️⃣ Interior Accessories\n2️⃣ Exterior Accessories\n3️⃣ Car Lighting\n4️⃣ Cameras & Sensors\n5️⃣ Practical Accessories\n6️⃣ Product Enquiry\n0️⃣ Main Menu',
  },
  {
    key: 'car_care',
    category: 'Services',
    titleAr: 'قائمة العناية بالسيارات',
    titleEn: 'Car Care Menu',
    ar: '✨ العناية بالسيارات\n\n1️⃣ غسيل وتنظيف السيارة الاحترافي\n2️⃣ تلميع خارجي وتصحيح طلاء\n3️⃣ تنظيف داخلي عميق بالبخار\n4️⃣ تنظيف وحماية المقاعد والجلد\n5️⃣ حماية الطلاء (نانو سيراميك)\n6️⃣ عناية شاملة (باقة كاملة)\n7️⃣ استفسار عن الأسعار\n0️⃣ القائمة الرئيسية',
    en: '✨ Car Care\n\n1️⃣ Car Cleaning\n2️⃣ Exterior Polishing & Paint Correction\n3️⃣ Interior Steam Detailing\n4️⃣ Seat & Leather Cleaning\n5️⃣ Paint Protection (Nano Ceramic)\n6️⃣ Full Detailing Package\n7️⃣ Price Enquiry\n0️⃣ Main Menu',
  },
  {
    key: 'tinting_protection',
    category: 'Services',
    titleAr: 'قائمة التظليل والحماية',
    titleEn: 'Tinting & Protection Menu',
    ar: '🛡️ التظليل والحماية\n\n1️⃣ تظليل زجاج السيارات (عازل نانو سيراميك)\n2️⃣ حماية الطلاء النانو فيلم (PPF)\n3️⃣ حماية المصابيح والشمعات\n4️⃣ حماية المقصورة الداخلية والديكور\n5️⃣ استفسار عن الأسعار\n0️⃣ القائمة الرئيسية',
    en: '🛡️ Tinting & Protection\n\n1️⃣ Window Tinting (Nano Ceramic Heat Rejection)\n2️⃣ Paint Protection Film (PPF)\n3️⃣ Headlight Protection\n4️⃣ Interior Cabin Protection\n5️⃣ Price Enquiry\n0️⃣ Main Menu',
  },

  // ---------------------------------------------------------- Service Details
  detail('car_audio_1', 'صوتيات · أنظمة صوتية كاملة', 'Car Audio · Complete Sound System',
    'أنظمة صوتية كاملة: نوفر أحدث البكجات الاحترافية الموزونة خصيصاً لمقصورة سيارتك. للاستفسار عن البكج المناسب لموديل سيارتك، يرجى كتابة نوع وموديل السيارة.',
    'Complete Sound Systems: Customized tuned packages for your vehicle cabin acoustics. Please reply with your car model for tailored options.'),
  detail('car_audio_2', 'صوتيات · شاشات السيارات', 'Car Audio · Screens & Displays',
    'شاشات السيارات: شاشات أندرويد وآبل كاربلاي فائقة الوضوح متوافقة بالكامل مع كاميرات وحساسات الوكالة وأزرار الدركسون.',
    'Android & CarPlay Displays: High-definition touchscreens fully compatible with OEM cameras, sensors, and steering controls.'),
  detail('car_audio_3', 'صوتيات · سماعات السيارات', 'Car Audio · Car Speakers',
    'سماعات السيارات: سماعات كواكسيل وسبيكرات نقية من أفضل العلامات العالمية المعتمدة.',
    'Car Speakers: High-fidelity component and coaxial speakers from top certified audio brands.'),
  detail('car_audio_4', 'صوتيات · مضخمات الصوت', 'Car Audio · Amplifiers',
    'مضخمات الصوت (Amplifiers): مضخمات رقمية مدمجة بقدرات عالية وصوت نقي بدون تشويش.',
    'Amplifiers: Compact high-performance digital multi-channel amplifiers delivering clean output.'),
  detail('car_audio_5', 'صوتيات · ساب ووفر', 'Car Audio · Subwoofers',
    'ساب ووفر (Subwoofers): مضخمات باس بصناديق مدمجة لا تأخذ حيزاً من مساحة الشنطة.',
    'Subwoofers: Deep low-frequency subwoofers in space-efficient enclosures.'),
  detail('car_audio_6', 'صوتيات · تحسين وترقية الصوت', 'Car Audio · Sound Upgrade',
    'تحسين وترقية الصوت: عزل صوتي للأبواب وتوزيع احترافي لنقاء صوت سينمائي.',
    'Sound Upgrade: Acoustic door dampening and professional sound calibration.'),
  detail('car_audio_7', 'صوتيات · استفسار عن الأسعار', 'Car Audio · Price Enquiry',
    'استفسار عن الأسعار: تعتمد أسعار الصوتيات والشاشات على نوع السيارة والماركة المطلوبة. أرسل نوع سيارتك وسنزودك بتقرير الأسعار المعتمدة.',
    'Price Enquiry: Audio prices vary by vehicle model and specifications. Please share your vehicle details for exact pricing.'),

  detail('car_accessories_1', 'إكسسوارات · داخلية', 'Accessories · Interior',
    'إكسسوارات داخلية: تلبيس أرضيات، حوامل ذكية، أغطية حماية لديكور السيارة والمقود.',
    'Interior Accessories: Floor mats, smart magnetic mounts, and interior trim protectors.'),
  detail('car_accessories_2', 'إكسسوارات · خارجية', 'Accessories · Exterior',
    'إكسسوارات خارجية: أغطية مرايا، حواف حماية، مسكات أبواب، ولمسات رياضية مميزة.',
    'Exterior Accessories: Mirror caps, protective moldings, and aesthetic vehicle trims.'),
  detail('car_accessories_3', 'إكسسوارات · إضاءة السيارات', 'Accessories · Car Lighting',
    'إضاءة السيارات: أنظمة إضاءة محيطية (Ambient Light) ولمبات LED عالية القوة والسطوع.',
    'Car Lighting: Ambient interior lighting kits and high-performance certified LED upgrades.'),
  detail('car_accessories_4', 'إكسسوارات · كاميرات وحساسات', 'Accessories · Cameras & Sensors',
    'كاميرات وحساسات: كاميرات 360 درجة، داش كام بدقة 4K، وحساسات أمامية وخلفية.',
    'Cameras & Sensors: 360-degree cameras, 4K Dash Cams, and parking radar sensors.'),
  detail('car_accessories_5', 'إكسسوارات · عملية وتقنية', 'Accessories · Practical',
    'إكسسوارات عملية: منافذ شحن سريعة، مضخات هواء ذكية، وأجهزة طوارئ متكاملة.',
    'Practical Accessories: Fast wireless car chargers, smart tire inflators, and emergency packs.'),
  detail('car_accessories_6', 'إكسسوارات · الاستفسار عن منتج', 'Accessories · Product Enquiry',
    'الاستفسار عن منتج: اذكر اسم المنتج المطلوب وموديل سيارتك وسيقوم فريقنا بتأكيد التوفر لك.',
    'Product Enquiry: Please specify the accessory and car model and our team will confirm availability.'),

  detail('car_care_1', 'عناية · غسيل وتنظيف احترافي', 'Car Care · Cleaning',
    'غسيل وتنظيف احترافي: غسيل تفصيلي بمواد مخصصة خالية من الأملاح مع تجفيف بأقمشة مايكروفايبر فائقة النعومة.',
    'Car Cleaning: Professional hand wash using pH-neutral chemicals and premium microfiber drying.'),
  detail('car_care_2', 'عناية · تلميع خارجي', 'Car Care · Exterior Polishing',
    'تلميع خارجي: تصحيح طلاء خماسي المراحل لإزالة الدوائر والخدوش السطحية واستعادة لمعان الوكالة.',
    'Exterior Polishing: Multi-stage paint correction removing swirl marks and restoring deep mirror gloss.'),
  detail('car_care_3', 'عناية · تنظيف داخلي', 'Car Care · Interior Detailing',
    'تنظيف داخلي: تعقيم عميق بالبخار، إزالة البقع والأتربة من المراتب والديكور مع تعطير طبيعي.',
    'Interior Detailing: High-temperature steam sanitization, upholstery stain extraction, and cabin conditioning.'),
  detail('car_care_4', 'عناية · المقاعد والجلد', 'Car Care · Seat & Leather',
    'تنظيف المقاعد والجلد: معالجة المقاعد الجلدية بمرطبات لحمايتها من التشقق والجفاف بحرارة الصيف.',
    'Seat & Leather Cleaning: Deep leather conditioning preventing cracking caused by summer heat.'),
  detail('car_care_5', 'عناية · حماية الطلاء', 'Car Care · Paint Protection',
    'حماية الطلاء: طبقات نانو سيراميك 9H/10H مقاومة للعوامل الجوية مع صيانة دورية مجانية.',
    'Paint Protection: Multi-layer 9H/10H nano ceramic coatings with bi-annual free inspections.'),
  detail('car_care_6', 'عناية · باقة شاملة', 'Car Care · Full Detailing',
    'عناية شاملة: باقة ملكية تضم تلميع كامل داخلي وخارجي وحماية حواف الأبواب ومحرك السيارة.',
    'Full Detailing Package: Royal package combining interior, exterior, engine bay, and edge protection.'),
  detail('car_care_7', 'عناية · استفسار عن الأسعار', 'Car Care · Price Enquiry',
    'استفسار عن الأسعار: تعتمد أسعار خدمات العناية على حجم ونوع السيارة وحالة الطلاء. يرجى تزويدنا بموديل سيارتك والخدمة المطلوبة وسنزودك بالسعر المعتمد.',
    'Price Enquiry: Car care prices depend on vehicle size, type, and paint condition. Please share your vehicle model and the service you need and we will confirm the official price.'),

  detail('tinting_protection_1', 'تظليل · تظليل الزجاج', 'Tinting · Window Tinting',
    'تظليل زجاج السيارات: عازل حراري نانو سيراميك أصلي يعزل نسبة عالية من الأشعة تحت الحمراء ومصرح رسمياً من إدارة المرور.',
    'Window Tinting: Genuine certified Nano Ceramic film rejecting a high share of infrared heat, compliant with traffic laws.'),
  detail('tinting_protection_2', 'تظليل · حماية الطلاء PPF', 'Tinting · PPF',
    'حماية الطلاء (PPF): فيلم معالج ذاتياً ضد الحصى والترميل مع ضمان طويل يشمل الصيانة المجانية.',
    'Paint Protection Film (PPF): Self-healing thermoplastic polyurethane film against road debris, with a long-term warranty.'),
  detail('tinting_protection_3', 'تظليل · حماية المصابيح', 'Tinting · Headlight Protection',
    'حماية المصابيح: حماية الشمعات الأمامية من الاصفرار والعج والترميل مع ضمان.',
    'Headlight Protection: Specialized UV and sandstorm resistant film preventing yellowing and haze.'),
  detail('tinting_protection_4', 'تظليل · حماية المقصورة', 'Tinting · Interior Protection',
    'حماية المقصورة الداخلية: أفلام شفافة لشاشات اللمس وديكورات البيانو بلاك لحمايتها من الخدوش.',
    'Interior Cabin Protection: Pre-cut transparent protection for infotainment screens and piano-black trims.'),
  detail('tinting_protection_5', 'تظليل · استفسار عن الأسعار', 'Tinting · Price Enquiry',
    'استفسار عن الأسعار: تعتمد أسعار العازل الحراري وحماية PPF على حجم السيارة والمساحة المطلوبة. أرسل موديل سيارتك وسنزودك بالسعر المعتمد.',
    'Price Enquiry: Window tint and PPF prices depend on vehicle size and coverage. Please share your vehicle model and we will confirm the official price.'),

  // ----------------------------------------------------------- Prices & Offers
  {
    key: 'prices_enquiries',
    category: 'Prices & Offers',
    titleAr: 'قائمة الأسعار والعروض',
    titleEn: 'Prices & Offers Menu',
    ar: '💰 الأسعار والعروض\n\nاختر الخدمة المطلوبة:\n\n1️⃣ أسعار المنتجات (صوتيات وشاشات وإكسسوارات)\n2️⃣ أسعار الخدمات (حماية وعوازل وتلميع)\n3️⃣ العروض الحالية المعتمدة\n4️⃣ طلب عرض سعر مخصص\n5️⃣ سلة الاستفسارات (مراجعة وطلب تسعيرة)\n0️⃣ القائمة الرئيسية',
    en: '💰 Prices & Offers\n\nPlease select an option:\n\n1️⃣ Product Prices\n2️⃣ Service Prices\n3️⃣ Current Offers\n4️⃣ Custom Quotation\n5️⃣ Inquiry Cart\n0️⃣ Main Menu',
  },
  {
    key: 'prices_products',
    category: 'Prices & Offers',
    titleAr: 'أسعار المنتجات',
    titleEn: 'Product Prices',
    ar: '📦 أسعار المنتجات في رواد ألفا\n\nتُعتمد أسعار الصوتيات والشاشات والإكسسوارات حسب نوع السيارة والمواصفات المطلوبة. الأسعار غير المؤكدة تُعرض "السعر عند الطلب".\n\n💡 للاستفسار عن منتج، أرسل اسم المنتج ونوع سيارتك وسيزودك فريقنا بالسعر المعتمد.\n\n4️⃣ طلب عرض سعر مخصص\n0️⃣ القائمة الرئيسية',
    en: '📦 Product Prices at Rowad Alfa\n\nAudio, screen, and accessory prices are confirmed per vehicle and specification. Unconfirmed prices are shown as "Price on Request".\n\n💡 To enquire about a product, reply with the product name and your vehicle model and our team will confirm the official price.\n\n4️⃣ Custom Quotation\n0️⃣ Main Menu',
  },
  {
    key: 'prices_services',
    category: 'Prices & Offers',
    titleAr: 'أسعار الخدمات',
    titleEn: 'Service Prices',
    ar: '🛠️ أسعار الخدمات في رواد ألفا للعناية بالسيارات\n\n1️⃣ حماية الطلاء النانو فيلم (PPF) — واجهة أو كامل البودي\n2️⃣ نانو سيراميك 9H/10H — سيدان أو جيب\n3️⃣ عازل حراري نانو سيراميك — سيدان أو سيارات كبيرة\n4️⃣ تلميع ساطع وعناية ملكية شاملة\n\n💡 الأسعار الدقيقة تعتمد على حجم ونوع وموديل السيارة، ويؤكدها فريقنا لك مباشرة.\n\n4️⃣ طلب عرض سعر مخصص\n0️⃣ القائمة الرئيسية',
    en: '🛠️ Service Prices at Rowad Alfa Auto Care\n\n1️⃣ Paint Protection Film (PPF) — front-end or full body\n2️⃣ Nano Ceramic 9H/10H coating — sedans or SUVs\n3️⃣ Nano Ceramic window tint — sedans or large vehicles\n4️⃣ Royal detailing & multi-stage polishing\n\n💡 Exact pricing depends on vehicle make, size, and model and is confirmed by our team.\n\n4️⃣ Custom Quotation\n0️⃣ Main Menu',
  },
  {
    key: 'prices_offers_list',
    category: 'Prices & Offers',
    titleAr: 'العروض الحالية (قائمة من وحدة العروض)',
    titleEn: 'Current Offers (from the Offers module)',
    ar: '🎁 العروض الحالية المعتمدة في رواد ألفا:\n\n{offers}\n\n💡 للاستفادة من العرض، أرسل اسمك ونوع سيارتك أو اطلب عرض سعر مخصص.\n\n4️⃣ طلب عرض سعر مخصص\n0️⃣ القائمة الرئيسية',
    en: '🎁 Current Verified Offers at Rowad Alfa:\n\n{offers}\n\n💡 To claim an offer, reply with your vehicle model or request a custom quotation.\n\n4️⃣ Custom Quotation\n0️⃣ Main Menu',
  },
  {
    key: 'prices_offers',
    category: 'Prices & Offers',
    titleAr: 'لا توجد عروض حالياً',
    titleEn: 'No Current Offers',
    ar: '🎁 لا توجد عروض موسمية إضافية حالياً. يمكنك طلب عرض سعر مخصص لسيارتك!\n\n4️⃣ طلب عرض سعر مخصص\n0️⃣ القائمة الرئيسية',
    en: '🎁 No additional seasonal promotions at this moment. You can request a custom quotation for your vehicle!\n\n4️⃣ Custom Quotation\n0️⃣ Main Menu',
  },
  {
    key: 'prices_inquiry_cart',
    category: 'Prices & Offers',
    titleAr: 'سلة الاستفسارات',
    titleEn: 'Inquiry Cart',
    ar: '🛒 سلة الاستفسارات (Inquiry Cart):\n\nسلتك فارغة حالياً.\nيمكنك إضافة أي خدمة أو منتج (حماية PPF، عازل حراري، نانو سيراميك، شاشات أندرويد) عبر طلب عرض سعر مخصص.\n\n4️⃣ طلب عرض سعر مخصص لسيارتك\n0️⃣ القائمة الرئيسية',
    en: '🛒 Inquiry Cart:\n\nYour inquiry cart is currently empty.\nYou can add any service or product (PPF, Window Tint, Ceramic, Android Display) by requesting a custom quotation.\n\n4️⃣ Request Custom Quotation\n0️⃣ Main Menu',
  },

  // --------------------------------------------------------------- Information
  {
    key: 'location_hours',
    category: 'Information',
    titleAr: 'الموقع وساعات العمل',
    titleEn: 'Location & Hours',
    ar: '📍 {business}\n\nالموقع: {address}\nرابط الموقع على خرائط جوجل: {maps}\n\n⏰ ساعات العمل:\n{hours}\n\n🅿️ {notes}\n\n0️⃣ القائمة الرئيسية',
    en: '📍 {business}\n\nLocation: {address}\nGoogle Maps: {maps}\n\n⏰ Opening Hours:\n{hours}\n\n🅿️ {notes}\n\n0️⃣ Main Menu',
  },
  {
    key: 'about',
    category: 'Information',
    titleAr: 'معلومات عن رواد ألفا',
    titleEn: 'About Rowad Alfa',
    ar: 'ℹ️ شركة رواد ألفا للعناية بالسيارات\n\nمركز رائد ومتخصص في:\n• أنظمة صوتيات وشاشات السيارات الحديثة\n• إكسسوارات السيارات المتميزة وأنظمة الإضاءة\n• التظليل والعوازل الحرارية النانو سيراميك المعتمدة\n• أفلام حماية الطلاء PPF بضمان طويل الأمد\n• خدمات التلميع الساطع والعناية الاحترافية الشاملة\n\nنسعى دائماً لتقديم أعلى معايير الجودة والضمان لعملائنا في المملكة العربية السعودية.\n\n0️⃣ القائمة الرئيسية',
    en: 'ℹ️ Rowad Alfa Auto Care\n\nA leading specialized center in Saudi Arabia for:\n• Premium Car Audio Systems & Android Screens\n• High-grade Car Accessories & Custom Lighting\n• Approved Nano Ceramic Heat Rejection Window Tinting\n• Self-healing PPF Paint Protection Film with long-term warranty\n• Professional Multi-stage Detailing & Polishing\n\nDedicated to delivering the highest quality and guaranteed customer satisfaction.\n\n0️⃣ Main Menu',
  },

  // -------------------------------------------------------------- Appointments
  {
    key: 'appointment_intro',
    category: 'Appointments',
    titleAr: 'مقدمة حجز الموعد',
    titleEn: 'Appointment Booking Intro',
    ar: '📅 حجز موعد\n\nسأطرح عليك بعض الأسئلة لإرسال طلب الحجز إلى فريقنا.\n(أرسل 0 في أي وقت للرجوع للقائمة الرئيسية)\n\n1️⃣ ما هو اسمك الكريم؟',
    en: '📅 Book an Appointment\n\nI will ask a few questions to submit your appointment request to our team.\n(Reply 0 at any time to return to the main menu)\n\n1️⃣ What is your full name?',
  },
  { key: 'appointment_step_2', category: 'Appointments', titleAr: 'حجز موعد · ماركة السيارة', titleEn: 'Appointment · Vehicle Make',
    ar: '2️⃣ ما هي ماركة وصانع السيارة؟ (مثال: تويوتا، لكزس، نيسان):', en: '2️⃣ What is the vehicle make? (e.g. Toyota, Lexus, Nissan):' },
  { key: 'appointment_step_3', category: 'Appointments', titleAr: 'حجز موعد · موديل السيارة', titleEn: 'Appointment · Vehicle Model',
    ar: '3️⃣ ما هو طراز وموديل السيارة؟ (مثال: لاندكروزر، كامري، باترول):', en: '3️⃣ What is the vehicle model? (e.g. Land Cruiser, Camry, Patrol):' },
  { key: 'appointment_step_4', category: 'Appointments', titleAr: 'حجز موعد · سنة الصنع', titleEn: 'Appointment · Vehicle Year',
    ar: '4️⃣ سنة الصنع؟ (مثال: 2025):', en: '4️⃣ What is the vehicle year? (e.g. 2025):' },
  { key: 'appointment_step_5', category: 'Appointments', titleAr: 'حجز موعد · الخدمة المطلوبة', titleEn: 'Appointment · Service',
    ar: '5️⃣ ما هي الخدمة المطلوبة؟ (مثال: حماية PPF، عازل حراري، نانو سيراميك، صوتيات، تلميع):', en: '5️⃣ What service do you require? (e.g. PPF Protection, Tinting, Nano Ceramic, Audio, Detailing):' },
  { key: 'appointment_step_6', category: 'Appointments', titleAr: 'حجز موعد · التاريخ المفضل', titleEn: 'Appointment · Preferred Date',
    ar: '6️⃣ ما هو التاريخ المفضل لزيارتنا؟ (مثال: الثلاثاء 23 سبتمبر):', en: '6️⃣ What is your preferred date? (e.g. Tuesday 23 September):' },
  { key: 'appointment_step_7', category: 'Appointments', titleAr: 'حجز موعد · الوقت المفضل', titleEn: 'Appointment · Preferred Time',
    ar: '7️⃣ ما هو الوقت المفضل؟ (صباحاً 10:00 ص أو مساءً 6:00 م):', en: '7️⃣ What is your preferred time? (e.g. Morning 10:00 AM or Evening 6:00 PM):' },
  { key: 'appointment_step_8', category: 'Appointments', titleAr: 'حجز موعد · ملاحظات', titleEn: 'Appointment · Notes',
    ar: '8️⃣ هل لديك أي ملاحظات أو طلبات خاصة؟ (أرسل "لا" في حال عدم وجود ملاحظات):', en: '8️⃣ Any additional notes or special requests? (Reply "No" if none):' },
  {
    key: 'appointment_confirm',
    category: 'Appointments',
    titleAr: 'تأكيد استلام طلب الحجز',
    titleEn: 'Appointment Received Confirmation',
    ar: 'شكراً لك. تم استلام طلب الحجز الخاص بك.\n\n📋 الرقم المرجعي: {reference}\n\nسيقوم فريقنا بمراجعة التوفر والتواصل معك لتأكيد الموعد.\n\nالموعد غير مؤكد حتى يصلك تأكيد رسمي من الفريق.\n\n0️⃣ القائمة الرئيسية',
    en: 'Thank you. Your appointment request has been received.\n\n📋 Reference: {reference}\n\nOur team will check availability and contact you to confirm the appointment.\n\nThe appointment is not confirmed until you receive confirmation from our team.\n\n0️⃣ Main Menu',
  },

  // ----------------------------------------------------------------- Quotation
  {
    key: 'quotation_intro',
    category: 'Quotation',
    titleAr: 'طلب عرض سعر · مقدمة',
    titleEn: 'Custom Quotation · Intro',
    ar: '📋 طلب عرض سعر مخصص:\n\nسأطرح عليك بعض الأسئلة لإعداد عرض السعر الرسمي لسيارتك.\n(أرسل 0 في أي وقت للرجوع للقائمة الرئيسية)\n\n1️⃣ ما هو اسمك الكريم؟',
    en: '📋 Custom Quotation Request:\n\nI will collect your vehicle details to prepare an official quotation.\n(Reply 0 at any time to return to the main menu)\n\n1️⃣ What is your full name?',
  },
  { key: 'quotation_step_2', category: 'Quotation', titleAr: 'طلب عرض سعر · السيارة', titleEn: 'Custom Quotation · Vehicle',
    ar: '2️⃣ ما هي ماركة وطراز وسنة السيارة؟\n(مثال: تويوتا لاندكروزر 2024):', en: '2️⃣ What is your vehicle make, model, and year?\n(e.g. Toyota Land Cruiser 2024):' },
  { key: 'quotation_step_3', category: 'Quotation', titleAr: 'طلب عرض سعر · الخدمة', titleEn: 'Custom Quotation · Service',
    ar: '3️⃣ ما هي الخدمة أو المنتج المطلوب؟\n(مثال: حماية PPF كاملة، عازل حراري، نانو سيراميك، شاشة أندرويد):', en: '3️⃣ What service or product do you need?\n(e.g. Full PPF, Window Tint, Nano Ceramic, Android Screen):' },
  { key: 'quotation_step_4', category: 'Quotation', titleAr: 'طلب عرض سعر · ملاحظات', titleEn: 'Custom Quotation · Notes',
    ar: '4️⃣ هل لديك أي ملاحظات أو طلبات إضافية؟\n(أرسل "لا" في حال عدم وجود ملاحظات):', en: '4️⃣ Any additional notes or special requests?\n(Reply "No" if none):' },
  {
    key: 'quotation_confirm',
    category: 'Quotation',
    titleAr: 'تأكيد استلام طلب عرض السعر',
    titleEn: 'Quotation Received Confirmation',
    ar: '✅ تم استلام طلب عرض السعر بنجاح!\n\n📋 الرقم المرجعي: {reference}\nسيتواصل معك فريقنا خلال يوم عمل لتأكيد السعر الرسمي.\n\n🏠 رواد ألفا للعناية بالسيارات\n📍 جدة، المملكة العربية السعودية\n\n0️⃣ القائمة الرئيسية',
    en: '✅ Quotation request received successfully!\n\n📋 Reference: {reference}\nOur team will contact you within 1 business day with the official price.\n\n🏠 Rowad Alfa Auto Care\n📍 Jeddah, Saudi Arabia\n\n0️⃣ Main Menu',
  },

  // ---------------------------------------------------- Request status (customer)
  {
    key: 'request_confirmed',
    category: 'Request Status',
    titleAr: 'تأكيد الموعد / الطلب',
    titleEn: 'Request Confirmed',
    ar: '✅ تم تأكيد طلبك ({kind})\n\n📋 الرقم المرجعي: {reference}\n👤 الاسم: {name}\n🔧 الخدمة: {service}\n📅 التاريخ: {date}\n⏰ الوقت: {time}\n\nنرحب بك في {business}.\n📍 الموقع: {maps}\n\nيرجى الوصول قبل الموعد بعشر دقائق وإحضار السيارة نظيفة قدر الإمكان.\nلأي تعديل أرسل: موظف',
    en: '✅ Your {kind} request is confirmed\n\n📋 Reference: {reference}\n👤 Name: {name}\n🔧 Service: {service}\n📅 Date: {date}\n⏰ Time: {time}\n\nWe look forward to welcoming you at {business}.\n📍 Location: {maps}\n\nPlease arrive 10 minutes early. To change anything, reply: agent',
  },
  {
    key: 'request_rejected',
    category: 'Request Status',
    titleAr: 'رفض الطلب',
    titleEn: 'Request Rejected',
    ar: '❌ نعتذر، لم نتمكن من قبول طلبك ({kind}) رقم {reference} في الوقت المطلوب.\n\nيمكنك اختيار وقت آخر عبر 7️⃣ حجز موعد، أو التحدث مع موظف بإرسال: موظف\n\n{business}',
    en: '❌ Sorry, we could not accept your {kind} request {reference} for the requested time.\n\nYou can choose another time via 7️⃣ Book an Appointment, or reply: agent to talk to our staff.\n\n{business}',
  },
  {
    key: 'request_cancelled',
    category: 'Request Status',
    titleAr: 'إلغاء الطلب',
    titleEn: 'Request Cancelled',
    ar: '🚫 تم إلغاء طلبك ({kind}) رقم {reference}.\n\nإذا كان ذلك عن طريق الخطأ أو تريد إعادة الحجز، أرسل 7️⃣ أو تحدث مع موظف بإرسال: موظف\n\n{business}',
    en: '🚫 Your {kind} request {reference} has been cancelled.\n\nIf this was a mistake or you want to rebook, reply 7️⃣ or reply: agent to talk to our staff.\n\n{business}',
  },
  {
    key: 'request_status_update',
    category: 'Request Status',
    titleAr: 'تحديث حالة الطلب',
    titleEn: 'Request Status Update',
    ar: 'ℹ️ تحديث لطلبك ({kind}) رقم {reference}\n\nالحالة الحالية: {status}\n\nشكراً لك — {business}',
    en: 'ℹ️ Update on your {kind} request {reference}\n\nCurrent status: {status}\n\nThank you — {business}',
  },

  // ------------------------------------------------------ Staff notifications
  {
    key: 'staff_new_request',
    category: 'Staff Notifications',
    titleAr: 'إشعار الموظفين: طلب جديد',
    titleEn: 'Staff Alert: New Request',
    bilingual: true,
    ar: '🆕 NEW {kind} REQUEST / طلب {kind} جديد\n\nReference: {reference}\nCustomer: {customer}\n{details}\n\nStatus: {status}\n\nReply with one of:\nCONFIRM {reference}\nREJECT {reference}\nCANCEL {reference}\nCOMPLETE {reference}\n(أو: تأكيد / رفض / إلغاء / إكمال {reference})\n\nOr manage it in the dashboard → Appointments.',
    en: '🆕 NEW {kind} REQUEST / طلب {kind} جديد\n\nReference: {reference}\nCustomer: {customer}\n{details}\n\nStatus: {status}\n\nReply with one of:\nCONFIRM {reference}\nREJECT {reference}\nCANCEL {reference}\nCOMPLETE {reference}\n(أو: تأكيد / رفض / إلغاء / إكمال {reference})\n\nOr manage it in the dashboard → Appointments.',
  },
  {
    key: 'staff_status_changed',
    category: 'Staff Notifications',
    titleAr: 'إشعار الموظفين: تغيير الحالة',
    titleEn: 'Staff Alert: Status Changed',
    bilingual: true,
    ar: '🔄 {reference} → {status}\nBy: {actor}\nCustomer: {customer} · {name}\n{service} {date} {time}\n\nThe customer has been notified automatically (once per status).',
    en: '🔄 {reference} → {status}\nBy: {actor}\nCustomer: {customer} · {name}\n{service} {date} {time}\n\nThe customer has been notified automatically (once per status).',
  },

  // ------------------------------------------------------------------- Support
  {
    key: 'human_support',
    category: 'Support',
    titleAr: 'التحويل للتحدث مع موظف',
    titleEn: 'Human Support Handover',
    ar: '👨‍💼 سيتم تحويل طلبك إلى فريق خدمة العملاء.\n\nيرجى كتابة استفسارك بالتفصيل، وسيقوم أحد موظفينا بالرد عليك في أقرب وقت.\n\n(للرجوع للقائمة الآلية في أي وقت، أرسل: القائمة أو 0)',
    en: '👨‍💼 Your request will be forwarded to our customer service team.\n\nPlease describe your enquiry, and one of our staff members will respond shortly.\n\n(To return to the automated menu anytime, reply: Menu or 0)',
  },
  {
    key: 'unsupported_message',
    category: 'Support',
    titleAr: 'رسالة غير مدعومة',
    titleEn: 'Unsupported Message Type',
    bilingual: true,
    ar: UNSUPPORTED,
    en: UNSUPPORTED,
  },
  {
    key: 'fallback_error',
    category: 'Support',
    titleAr: 'رسالة الخطأ الاحتياطية',
    titleEn: 'Fallback / Error Message',
    ar: 'عذراً، حدث خطأ من جهتنا. يرجى المحاولة بعد لحظات أو التواصل معنا مباشرة إذا تكررت المشكلة.',
    en: 'Sorry, something went wrong on our end. Please try again in a moment, or contact us directly if this keeps happening.',
  },
  {
    key: 'ai_disabled',
    category: 'Support',
    titleAr: 'الرد عند إيقاف الذكاء الاصطناعي',
    titleEn: 'AI Replies Disabled Notice',
    ar: 'شكراً لرسالتك. سيقوم أحد موظفينا بالرد عليك قريباً. للقائمة الآلية أرسل: القائمة أو 0',
    en: 'Thanks for your message. A staff member will reply shortly. For the automated menu, reply: Menu or 0',
  },
];

/** Keys of templates removed from this list; unmodified rows are cleaned up on boot. */
export const RETIRED_TEMPLATE_KEYS = ['welcome'];
