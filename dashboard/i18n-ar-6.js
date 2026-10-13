// Arabic dictionary, part 6: template categories, section captions, time-ago, notification kinds and the remaining small labels.
window.I18N_AR = window.I18N_AR || {};
window.I18N_AR_PATTERNS = window.I18N_AR_PATTERNS || [];
Object.assign(window.I18N_AR, {
  // template categories and section captions (upper-case captions are literal text in the pages)
  'Greeting': 'الترحيب', 'GREETING': 'الترحيب',
  'Inquiry Cart': 'سلة الاستفسارات',
  'Prices & Offers': 'الأسعار والعروض', 'PRICES & OFFERS': 'الأسعار والعروض',
  'Request Status': 'حالة الطلب', 'REQUEST STATUS': 'حالة الطلب',
  'Business Menu': 'قائمة النشاط',
  'Welcome & Language Selection': 'الترحيب واختيار اللغة',
  'APPOINTMENTS': 'المواعيد', 'SERVICES': 'الخدمات', 'SUPPORT': 'الدعم', 'QUOTATION': 'عرض السعر', 'INFORMATION': 'معلومات',
  'STAFF NOTIFICATIONS': 'إشعارات الموظفين', 'BUSINESS DOCUMENTS': 'مستندات النشاط', 'NOT CONNECTED': 'غير متصل',
  'Language selection, main menu, category prompts, restart, change language.': 'اختيار اللغة، القائمة الرئيسية، رسائل التصنيفات، إعادة التشغيل، تغيير اللغة.',
  'Menu rule': 'قاعدة قائمة', 'Language': 'اللغة',

  // labels
  'AI': 'الذكاء الاصطناعي', 'AI knowledge only': 'معرفة الذكاء الاصطناعي فقط', 'AI replies stored': 'ردود الذكاء الاصطناعي المخزّنة',
  'Active (published now)': 'نشط (منشور الآن)', 'Document': 'مستند', 'Internal only': 'داخلي فقط', 'Needs attention': 'يحتاج إلى انتباه',
  'Customer-visible when requested': 'مرئي للعملاء عند الطلب',
  'Brochures, price lists, presentations': 'كتيبات وقوائم أسعار وعروض تقديمية',
  'Automatic “Price on Request” for unconfirmed items': '«السعر عند الطلب» تلقائياً للبنود غير المؤكدة',
  'Location / branch name': 'الموقع / اسم الفرع', 'Street, district, city': 'الشارع والحي والمدينة', 'Logo document id': 'معرّف مستند الشعار',
  'Who confirmed it and when': 'من أكّده ومتى',
  'Expired — click Refresh QR Code': 'انتهت الصلاحية — اضغط «تحديث رمز QR»',
  'QR code expired. Click Refresh QR to generate a new one.': 'انتهت صلاحية رمز QR. اضغط «تحديث QR» لتوليد رمز جديد.',
  'Nobody scanned in time. Click Refresh QR Code for a new one.': 'لم يمسح أحد الرمز في الوقت المناسب. اضغط «تحديث رمز QR» للحصول على رمز جديد.',
  'WhatsApp disconnected': 'واتساب غير متصل', 'WhatsApp: QR code expired': 'واتساب: انتهت صلاحية رمز QR',
  // the connection chip under the page header (pages-automation.js builds "WhatsApp: <status>"): every status reads in Arabic
  'WhatsApp: Not connected': 'واتساب: غير متصل', 'WhatsApp: Preparing session': 'واتساب: تجهيز الجلسة', 'WhatsApp: Pairing / connecting': 'واتساب: اقتران / اتصال',
  'WhatsApp: Reconnecting': 'واتساب: إعادة الاتصال', 'WhatsApp: Disconnected': 'واتساب: غير متصل', 'WhatsApp: Logged out — authentication required': 'واتساب: تم تسجيل الخروج — المصادقة مطلوبة',
  'WhatsApp: Connection error': 'واتساب: خطأ في الاتصال', 'WhatsApp Live': 'واتساب متصل',
  // dashboard home cards that were still English in the Arabic interface
  'No pending requests': 'لا توجد طلبات معلّقة', 'Quotation and appointment requests from WhatsApp appear here.': 'تظهر هنا طلبات عروض الأسعار والمواعيد الواردة من واتساب.',
  'No automatic replies in this period yet': 'لا توجد ردود تلقائية في هذه الفترة بعد',
  'Suppressed — document message — not answered automatically': 'مُنع — رسالة مستند — لا يُجاب عنها تلقائياً',
  'Right-click the spot in Google Maps → copy the coordinates. Map selection by click needs a Maps API key, which this app does not use.': 'انقر بزر الفأرة الأيمن على الموضع في خرائط Google ← انسخ الإحداثيات. اختيار الموقع بالنقر على الخريطة يحتاج إلى مفتاح Maps API الذي لا يستخدمه هذا التطبيق.',
  'The public HTTPS URL you register with Meta as the Callback URL. This application always answers at': 'رابط HTTPS العام الذي تسجّله لدى Meta كرابط الاستدعاء. يجيب هذا التطبيق دائماً على',
  'Website, Instagram, Facebook and other links are managed in the': 'تُدار روابط الموقع الإلكتروني وإنستغرام وفيسبوك وغيرها في',
  'The AI is instructed to quote only prices written in Knowledge Sources and to answer “Price on Request / السعر عند الطلب” for anything else. The current source of truth is': 'يُوجَّه الذكاء الاصطناعي بألا يذكر إلا الأسعار المكتوبة في مصادر المعرفة، وبأن يجيب «السعر عند الطلب» عن أي شيء آخر. المصدر الحالي للحقيقة هو',
  'Not verified: it is almost empty (too short to hold business facts). Edit it to add the real information; the assistant treats it as unknown.': 'غير موثّق: شبه فارغ (أقصر من أن يحمل حقائق النشاط). عدّله لإضافة المعلومات الحقيقية؛ يتعامل المساعد معه على أنه مجهول.',
  'Quotation requests created inside the selected dates, grouped by their status today. Approved means staff decided to quote; Sent means the quotation was actually delivered.': 'طلبات عروض الأسعار المنشأة ضمن التواريخ المحددة، مجمّعة حسب حالتها اليوم. تعني «تمت الموافقة» أن الموظفين قرروا تقديم عرض؛ وتعني «تم الإرسال» أن عرض السعر سُلِّم فعلاً.',
  '— WhatsApp removed this device (from the phone’s Linked devices, or WhatsApp invalidated the session). The old credentials are archived on the server; scan again to relink.': '— أزال واتساب هذا الجهاز (من الأجهزة المرتبطة في الهاتف، أو أبطل واتساب الجلسة). أُرشفت بيانات الاعتماد القديمة على الخادم؛ امسح الرمز مجدداً لإعادة الربط.',
  'is unstable (Wi-Fi, VPN, proxy). The session reconnects by itself; messages sent while it was down are answered when it is back. Nothing needs to be re-scanned.': 'غير مستقر (واي فاي أو VPN أو وكيل). تعيد الجلسة الاتصال تلقائياً؛ ويُجاب عن الرسائل المرسلة أثناء الانقطاع عند العودة. لا حاجة إلى مسح الرمز مجدداً.',
  'from any WhatsApp number to the connected agent number: you should receive the restart confirmation and the language selection, then': 'من أي رقم واتساب إلى رقم الوكيل المتصل: يجب أن تصلك رسالة تأكيد إعادة التشغيل ثم اختيار اللغة، ثم',
  'picks a language and shows the menu. Every step is logged above. No test messages are sent from this page — only real customer traffic is answered.': 'يختار لغة ويعرض القائمة. تُسجَّل كل خطوة أعلاه. لا تُرسل رسائل اختبار من هذه الصفحة — يُجاب فقط عن حركة العملاء الحقيقية.',
  'from these values': 'من هذه القيم', 'and': 'و', 'tab.': 'تبويب.', 'details:': 'التفاصيل:', 'name:': 'الاسم:', 'service:': 'الخدمة:',
  'Allowed:': 'المسموح:', 'max': 'الحد الأقصى',
  'dashboard': 'لوحة التحكم', 'system': 'النظام', 'delivered through WhatsApp': 'سُلِّم عبر واتساب',
  'Sun': 'الأحد', 'Mon': 'الاثنين', 'Tue': 'الثلاثاء', 'Wed': 'الأربعاء', 'Thu': 'الخميس', 'Fri': 'الجمعة', 'Sat': 'السبت',
  'just now': 'الآن',

  // Customer Reports: the friendly names of the figures
  'Quotation requests by status': 'طلبات عروض الأسعار حسب الحالة',
  'Quotations delivered ': 'عروض الأسعار المسلّمة',
  'Metric': 'المؤشر',
  'scheduled': 'مجدول', 'development': 'تطوير', 'owner': 'المالك', 'failed': 'فشل', 'General inquiry': 'استفسار عام',
  'The assistant currently answers product questions from Knowledge Sources (knowledge/services.md). A structured products table with images, availability and “Price on Request” handling is planned but has no backend today — this page will stay empty rather than show sample data.': 'يجيب المساعد حالياً عن أسئلة المنتجات من مصادر المعرفة (knowledge/services.md). جدول منتجات منظّم بالصور والتوفر ومعالجة «السعر عند الطلب» مخطَّط له لكن لا توجد له واجهة خلفية اليوم — ستبقى هذه الصفحة فارغة بدلاً من عرض بيانات تجريبية.',
  'One login and one database; every WhatsApp account is a separate business with its own profile, customers, conversations, requests, offers, documents, knowledge, replies, menu and WhatsApp session. Each dashboard request names its account and the server checks it.': 'تسجيل دخول واحد وقاعدة بيانات واحدة؛ وكل حساب واتساب نشاط تجاري مستقل بملفه وعملائه ومحادثاته وطلباته وعروضه ومستنداته ومعرفته وردوده وقائمته وجلسة واتساب الخاصة به. يحدد كل طلب من لوحة التحكم حسابه ويتحقق الخادم منه.',
  'Every dashboard user signs in with their own account (httpOnly session cookies, 12 h sliding, 7 day cap). The server checks the user\'s role, WhatsApp accounts and permissions on every request; API routes return 401 without a session and 403 without permission. Manage people under Users & Permissions.': 'يسجّل كل مستخدم الدخول بحسابه الخاص (ملفات تعريف ارتباط للجلسة من نوع httpOnly، مدة 12 ساعة متجددة بحد أقصى 7 أيام). يتحقق الخادم من دور المستخدم وحسابات واتساب والصلاحيات في كل طلب؛ وتعيد واجهات API الرمز 401 دون جلسة و403 دون صلاحية. أدِر المستخدمين من «المستخدمون والصلاحيات».',
  'English': 'الإنجليزية', 'This server': 'هذا الخادم', 'fetched from Baileys': 'مُجلب من Baileys',
  // messages returned by the server (kept generic on purpose: they never reveal whether an account exists)
  'invalid username or password': 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  'username and password are required': 'اسم المستخدم وكلمة المرور مطلوبان.',
  'username must be at least 3 characters': 'يجب ألا يقل اسم المستخدم عن 3 أحرف.',
  'password must be at least 12 characters': 'يجب ألا تقل كلمة المرور عن 12 حرفاً.',
  'an admin account already exists': 'يوجد حساب مسؤول بالفعل.',
  'challenge and code are required': 'رمز التحقق مطلوب.',
  'challenge is required': 'يجب تسجيل الدخول مجدداً.',
  'This sign-in attempt has expired. Please sign in again.': 'انتهت صلاحية محاولة تسجيل الدخول هذه. سجّل الدخول مجدداً.',
  'Too many sign-in attempts. Wait a few minutes and try again.': 'محاولات تسجيل دخول كثيرة جداً. انتظر بضع دقائق ثم حاول مجدداً.',
  'No more codes can be sent for this sign-in. Please start again.': 'لا يمكن إرسال رموز إضافية لهذه المحاولة. ابدأ من جديد.',
  'Verification codes cannot be sent right now (email delivery is not configured).': 'لا يمكن إرسال رموز التحقق الآن (لم يُضبط إرسال البريد الإلكتروني).',
  'This administrator account has no email address to receive verification codes.': 'ليس لحساب المسؤول هذا بريد إلكتروني لاستلام رموز التحقق.',
  'The verification email could not be sent. Please try again in a moment.': 'تعذّر إرسال رسالة التحقق. حاول مجدداً بعد قليل.',
  'Too many attempts. Please wait a few minutes and try again.': 'محاولات كثيرة جداً. انتظر بضع دقائق ثم حاول مجدداً.',
  'Too many code requests. Please wait a few minutes and try again.': 'طلبات رموز كثيرة جداً. انتظر بضع دقائق ثم حاول مجدداً.',
  'Too many sign-in attempts. Please wait a few minutes and try again.': 'محاولات تسجيل دخول كثيرة جداً. انتظر بضع دقائق ثم حاول مجدداً.',
  'Too many verification attempts. Please wait a few minutes and try again.': 'محاولات تحقق كثيرة جداً. انتظر بضع دقائق ثم حاول مجدداً.',
  'Too many uploads. Please wait a minute and try again.': 'عمليات رفع كثيرة جداً. انتظر دقيقة ثم حاول مجدداً.',
  'unauthenticated': 'انتهت الجلسة. سجّل الدخول مجدداً.', 'forbidden': 'ليست لديك صلاحية لهذا الإجراء.',
  'validation_failed': 'البيانات المُدخلة غير صالحة.', 'internal_server_error': 'حدث خطأ غير متوقع. حاول مجدداً.',
  'Operation failed': 'فشلت العملية.', 'Account operation failed': 'فشلت عملية الحساب.', 'Document operation failed': 'فشلت عملية المستند.',
  'Offer operation failed': 'فشلت عملية العرض.', 'Template operation failed': 'فشلت عملية القالب.',
  'Document not found': 'المستند غير موجود.', 'Offer not found': 'العرض غير موجود.', 'Template not found': 'القالب غير موجود.',
  'Request not found': 'الطلب غير موجود.', 'Customer not found': 'العميل غير موجود.', 'customer not found': 'العميل غير موجود.',
  'Conversation not found': 'المحادثة غير موجودة.', 'conversation not found': 'المحادثة غير موجودة.', 'booking not found': 'الحجز غير موجود.',
  'File not found': 'الملف غير موجود.', 'File not available': 'الملف غير متاح.', 'File or customer not found': 'الملف أو العميل غير موجود.',
  'The stored file is missing': 'الملف المخزَّن مفقود.', 'Draft not found': 'المسودة غير موجودة.', 'Open draft not found': 'المسودة المفتوحة غير موجودة.',
  'Link not found': 'الرابط غير موجود.', 'Catalogue not found': 'الكتالوج غير موجود.', 'User not found': 'المستخدم غير موجود.',
  'WhatsApp account not found': 'حساب واتساب غير موجود.',
  'The catalogue library is not enabled for this business': 'مكتبة الكتالوج غير مفعّلة لهذا النشاط.',
  'No WhatsApp account is assigned to this user': 'لا يوجد حساب واتساب مسند إلى هذا المستخدم.',
  'You do not have access to this WhatsApp account': 'ليس لديك حق الوصول إلى حساب واتساب هذا.',
  'You need access to conversations to reply to a customer': 'تحتاج إلى صلاحية المحادثات للرد على العميل.',
  'Notification not found or already sent': 'الإشعار غير موجود أو أُرسل بالفعل.',
  'Only a quotation request can have a quotation document': 'يمكن إرفاق مستند عرض سعر بطلب عرض سعر فقط.',
  'Unknown connection action': 'إجراء اتصال غير معروف.', 'Unknown offer action': 'إجراء عرض غير معروف.', 'unknown credential key': 'مفتاح اعتماد غير معروف.',
  'invalid customer id': 'معرّف العميل غير صالح.', 'invalid booking id': 'معرّف الحجز غير صالح.', 'invalid conversation id': 'معرّف المحادثة غير صالح.',
  'invalid id': 'المعرّف غير صالح.', 'invalid version id': 'معرّف النسخة غير صالح.',
  'could not be reached': 'تعذّر الوصول إليه',
  // exports and customer-file text extraction
  'Export customers': 'تصدير العملاء', 'Export quotations': 'تصدير عروض الأسعار', 'Export summary': 'تصدير الملخص',
  'Printing is not available here.': 'الطباعة غير متاحة هنا.', 'Export failed.': 'فشل التصدير.',
  'text read': 'تمت قراءة النص', 'text not read': 'لم تتم قراءة النص', 'text not read yet': 'لم تتم قراءة النص بعد',
  'Try reading the text again': 'إعادة محاولة قراءة النص', 'Read the text now': 'قراءة النص الآن',
  'The file is kept; open it to read it yourself.': 'الملف محفوظ؛ افتحه لقراءته بنفسك.',
  'Text read from the file': 'تمت قراءة النص من الملف', 'The text could not be read; the file is kept': 'تعذّرت قراءة النص؛ الملف محفوظ',
  'Only a PDF has a text layer to read': 'الملفات بصيغة PDF فقط لها طبقة نصية للقراءة', 'The file is not available': 'الملف غير متاح',
  'The text was already read': 'سبقت قراءة النص', 'This file was tried too many times. Open it and read it manually': 'جُرّب هذا الملف مرات كثيرة. افتحه واقرأه يدوياً',
  'Text extraction is busy, try again in a moment': 'استخراج النص مشغول، حاول مجدداً بعد قليل',
  'No readable text found — this PDF looks like scanned images (OCR is not available). Upload a text-based PDF or paste the content into Business Knowledge.': 'لم يُعثر على نص قابل للقراءة — يبدو أن ملف PDF هذا صور ممسوحة ضوئياً (التعرّف الضوئي على النص غير متاح). ارفع ملف PDF نصياً أو الصق المحتوى في معرفة النشاط.',
  'The stored file could not be found': 'تعذّر العثور على الملف المخزَّن', 'The stored file could not be read': 'تعذّرت قراءة الملف المخزَّن',
  'The file is not a valid PDF': 'الملف ليس PDF صالحاً', 'Text extraction failed unexpectedly': 'فشل استخراج النص بشكل غير متوقع',
  'Inquiries & carts': 'الاستفسارات والسلال', 'Documents & follow-ups': 'المستندات والمتابعات',
  // confirmations shown as toasts
  'WhatsApp: checking…': 'واتساب: جارٍ الفحص…',
  'Account updated.': 'تم تحديث الحساب.', 'Document uploaded.': 'تم رفع المستند.', 'Visibility updated.': 'تم تحديث الظهور.', 'File replaced.': 'تم استبدال الملف.',
  'Document deleted.': 'تم حذف المستند.', 'Link removed.': 'تمت إزالة الرابط.', 'Link updated. Read it again to refresh its content.': 'تم تحديث الرابط. اقرأه مجدداً لتحديث محتواه.',
  'Type saved.': 'تم حفظ النوع.', 'File deleted.': 'تم حذف الملف.', 'Only PDF files can be used.': 'يمكن استخدام ملفات PDF فقط.', 'Title saved.': 'تم حفظ العنوان.',
  'Catalogue deleted.': 'تم حذف الكتالوج.', 'Draft discarded.': 'تم تجاهل المسودة.', 'Menu reset.': 'تمت إعادة ضبط القائمة.',
  // developer credit and appearance
  'Developed by': 'تطوير',
  'Light appearance': 'المظهر الفاتح',
  'AI Workspace': 'مساحة العمل الذكية',
});
window.I18N_AR_PATTERNS.push(
  [/^(\d+)m ago$/, function (n) { return 'منذ ' + n + ' د'; }],
  [/^(\d+)h ago$/, function (n) { return 'منذ ' + n + ' س'; }],
  [/^(\d+)d ago$/, function (n) { return 'منذ ' + n + ' يوم'; }],
  [/^(\d+)s ago$/, function (n) { return 'منذ ' + n + ' ث'; }],
  [/^(Next|Previous) (.+) item$/, function (d, what) { var ar = window.I18N_AR[what]; return (d === 'Next' ? 'التالي: ' : 'السابق: ') + (ar || what); }],
  [/^Question (\d+) · (\w+)$/, function (n, f) { var m = { name: 'الاسم', make: 'الماركة', model: 'الموديل', year: 'السنة', service: 'الخدمة', date: 'التاريخ', time: 'الوقت', notes: 'الملاحظات', vehicle: 'السيارة', details: 'التفاصيل' }; return 'السؤال ' + n + ' · ' + (m[f] || f); }],
  [/^(customer quotation|customer status|business status|business new request|operator result): (\w+)$/, function (k, s) { var m = { 'customer quotation': 'عرض سعر للعميل', 'customer status': 'حالة للعميل', 'business status': 'حالة للنشاط', 'business new request': 'طلب جديد للنشاط', 'operator result': 'نتيجة المشغّل' }; return m[k] + ': ' + (window.I18N_AR[s] || s); }],
  [/^(\S+): (.+)$/, function (ref, rest) { if (!/^(INQ|APT)-/.test(ref)) return null; var ar = window.I18N.lookup(rest); return ar ? ref + ': ' + ar : null; }],
  [/^Too many ([a-z -]+)\. Please wait a few minutes and try again\.$/, function (w) { var m = { 'attempts': 'محاولات', 'sign-in attempts': 'محاولات تسجيل دخول', 'verification attempts': 'محاولات تحقق', 'code requests': 'طلبات رموز' }; return m[w] ? m[w] + ' كثيرة جداً. انتظر بضع دقائق ثم حاول مجدداً.' : null; }],
  [/^Please wait (\d+)s before requesting another code\.$/, function (n) { return 'انتظر ' + n + ' ثانية قبل طلب رمز آخر.'; }],
  [/^Verification failed \(HTTP (\d+)\)$/, function (n) { return 'فشل التحقق (HTTP ' + n + ')'; }],
  [/^Sign-in failed \(HTTP (\d+)\)$/, function (n) { return 'فشل تسجيل الدخول (HTTP ' + n + ')'; }],
  [/^Could not resend the code \(HTTP (\d+)\)$/, function (n) { return 'تعذّر إعادة إرسال الرمز (HTTP ' + n + ')'; }],
  [/^(\d+) page\(s\) · (.+)$/, function (n, when) { return n + ' صفحة · ' + when; }],
  [/^Could not read this PDF \((.*)\)\. It may be encrypted or damaged\.$/, function (why) { return 'تعذّرت قراءة ملف PDF هذا (' + why + '). قد يكون مشفّراً أو تالفاً.'; }],
  [/^The file is larger than (\d+) MB, so its text was not read$/, function (n) { return 'حجم الملف أكبر من ' + n + ' ميغابايت، لذا لم تُقرأ نصوصه'; }],
  [/^(\d+) needs attention$/, function (n) { return n + ' تحتاج إلى انتباه'; }],
  [/^notifications: (\d+) sent · (\d+) pending · (\d+) failed$/, function (a, b, c) { return 'الإشعارات: ' + a + ' مرسل · ' + b + ' قيد الانتظار · ' + c + ' فشل'; }],
  [/^Allowed: (.+) · max (.+)\. HTML is stored but never executed \(served as plain text\)\. Nothing is sent to customers automatically\.$/, function (types, max) { return 'المسموح: ' + types + ' · الحد الأقصى ' + max + '. يُخزَّن HTML ولا يُنفَّذ أبداً (يُعرض كنص عادي). لا يُرسَل شيء إلى العملاء تلقائياً.'; }],
  [/^Paste a maps\.app\.goo\.gl \/ maps\.google\.com link\. Default: (.+)$/, function (u) { return 'الصق رابط maps.app.goo.gl / maps.google.com. الافتراضي: ' + u; }],
  [/^Figures are live from the database for (.+?) · (.+?)(?: compared with the previous (\d+) days)?\. Updated (.+)\.$/, function (name, range, days, t) { return 'الأرقام مباشرة من قاعدة البيانات لـ ' + name + ' · ' + (window.I18N.lookup(range) || range) + (days ? ' مقارنةً بالـ ' + days + ' يوماً السابقة' : '') + '. آخر تحديث ' + t + '.'; }],
  [/^(.+) · (pending|preparing|approved|sent|expired|rejected|cancelled|completed|confirmed|new) →$/, function (when, s) { return when + ' · ' + (window.I18N.lookup(s) || s) + ' ←'; }],
  [/^(dashboard|system) \((.+)\)$/, function (who, name) { return (window.I18N.lookup(who) || who) + ' (' + (window.I18N.lookup(name) || name) + ')'; }],  [/^(.+?) ·$/, function (a) { var ar = window.I18N.lookup(a); return ar ? ar + ' ·' : null; }],
  [/^· (.+)$/, function (title) { var ar = window.I18N.lookup(title); return ar ? '· ' + ar : null; }]
);

// Real estate section (pages-realestate.js): navigation, titles, labels, statuses and messages.
Object.assign(window.I18N_AR, {
  'REAL ESTATE': 'العقارات',
  'Real Estate Overview': 'نظرة عامة على العقارات', 'Real Estate Leads': 'العملاء المحتملون (عقارات)', 'Projects & Properties': 'المشاريع والعقارات',
  'Consultations & Follow-ups': 'الاستشارات والمتابعات', 'Real Estate Documents': 'مستندات العقارات',
  'Enquiries, follow-ups, consultation requests and the verified projects of this business.': 'الاستفسارات والمتابعات وطلبات الاستشارة والمشاريع الموثّقة لهذا النشاط.',
  'Buyer, seller and investor enquiries from WhatsApp, with what each customer still has to tell us.': 'استفسارات المشترين والبائعين والمستثمرين من واتساب، مع ما لا يزال على كل عميل إخبارنا به.',
  'Enquiry': 'استفسار', 'Requirements, documents and follow-up for one customer.': 'المتطلبات والمستندات والمتابعة لعميل واحد.',
  'The verified projects customers can be told about. Nothing appears to customers until you publish it.': 'المشاريع الموثّقة التي يمكن إخبار العملاء بها. لا يظهر شيء للعملاء حتى تنشره.',
  'Enquiries that need a person, follow-ups that are due and consultation requests waiting for confirmation.': 'استفسارات تحتاج إلى موظف، ومتابعات مستحقة، وطلبات استشارة بانتظار التأكيد.',
  'Files customers with an enquiry have sent, with the review status of their enquiry. Only this business can open them.': 'ملفات أرسلها عملاء لديهم استفسار، مع حالة مراجعة استفسارهم. لا يفتحها إلا هذا النشاط.',
  // statuses, types, stages
  'New': 'جديد', 'Qualified': 'مؤهَّل', 'Awaiting information': 'بانتظار المعلومات', 'Assigned': 'مُسنَد', 'Follow-up required': 'تلزم المتابعة', 'Closed': 'مغلق',
  'Buyer': 'مشترٍ', 'Seller': 'بائع', 'Investor': 'مستثمر', 'General': 'عام', 'Priority': 'أولوية', 'High': 'عالية', 'Normal': 'عادية',
  'Not requested': 'لم تُطلب', 'Requested': 'مطلوبة', 'Reviewed by staff': 'راجعها الموظفون',
  'Upcoming': 'قريباً', 'Under construction': 'قيد الإنشاء', 'Completed': 'مكتمل', 'Sold out': 'نفدت الوحدات', 'See details': 'التفاصيل', 'Not stated': 'غير محدد',
  'Draft': 'مسودة', 'Published': 'منشور', 'Archived': 'مؤرشف', 'Brochure': 'كتيّب', 'Needs a person': 'يحتاج إلى موظف', 'Awaiting confirmation': 'بانتظار التأكيد',
  // overview
  'New today': 'جديدة اليوم', 'Open enquiries': 'استفسارات مفتوحة', 'Qualified, not assigned': 'مؤهَّلة وغير مُسنَدة', 'Need a person': 'تحتاج إلى موظف', 'Follow-ups due': 'متابعات مستحقة',
  'Consultation requests awaiting confirmation': 'طلبات استشارة بانتظار التأكيد', 'Published projects': 'المشاريع المنشورة', 'Enquiries by status': 'الاستفسارات حسب الحالة', 'Open enquiries by type': 'الاستفسارات المفتوحة حسب النوع',
  'No project has been entered yet. Customers are told that the team will review their requirements until you publish verified projects.': 'لم تُدخَل أي مشاريع بعد. يُخبَر العملاء بأن الفريق سيراجع متطلباتهم إلى أن تنشر مشاريع موثّقة.',
  // list
  'All': 'الكل', 'Buyers': 'المشترون', 'Sellers': 'البائعون', 'Investors': 'المستثمرون', 'Search reference, name, number or answers…': 'ابحث بالرقم المرجعي أو الاسم أو الرقم أو الإجابات…',
  'Open enquiries ': 'استفسارات مفتوحة', 'All statuses': 'كل الحالات', 'Follow-up due': 'المتابعة مستحقة', 'Customer': 'العميل', 'Type': 'النوع', 'Status': 'الحالة',
  'What they want': 'ما يريدونه', 'Staff': 'الموظف', 'Search enquiries': 'البحث في الاستفسارات',
  'No enquiries match these filters. Enquiries appear here when customers describe what they want to buy or sell on WhatsApp.': 'لا توجد استفسارات مطابقة. تظهر الاستفسارات هنا عندما يصف العملاء على واتساب ما يريدون شراءه أو بيعه.',
  // detail
  '← All enquiries': '← كل الاستفسارات', 'Customer profile': 'ملف العميل', 'Documents': 'المستندات', 'Next action': 'الإجراء التالي',
  'Add a note (kept in the history)': 'أضف ملاحظة (تُحفظ في السجل)', 'Save changes': 'حفظ التغييرات', 'Assign to me': 'إسناد إليّ', 'Unassign me': 'إلغاء إسنادي',
  'You can view this enquiry but not change it.': 'يمكنك عرض هذا الاستفسار دون تعديله.', 'What the customer told us': 'ما أخبرنا به العميل', 'Nothing yet.': 'لا شيء بعد.',
  'The assistant never asks for identity documents or bank details in the chat, and nothing here is verified by the system.': 'لا يطلب المساعد وثائق الهوية أو البيانات البنكية في المحادثة، ولا يتحقق النظام من أي شيء هنا.',
  'Interested projects': 'المشاريع المهتم بها', 'None recorded.': 'لا شيء مسجّل.', 'Documents from this customer': 'مستندات من هذا العميل', 'File': 'الملف', 'Size': 'الحجم', 'Open': 'فتح',
  'Not available': 'غير متاح', 'No documents received.': 'لم تُستلم أي مستندات.', 'History': 'السجل', 'No history.': 'لا يوجد سجل.',
  'The customer asked for a person or the assistant flagged this enquiry for staff.': 'طلب العميل التحدث مع موظف أو أحال المساعد هذا الاستفسار إلى الموظفين.',
  'Enquiry saved.': 'تم حفظ الاستفسار.',
  // projects
  'Projects': 'المشاريع', 'Add project': 'إضافة مشروع', 'Edit project': 'تعديل المشروع', 'Add a project': 'إضافة مشروع', 'Project': 'المشروع', 'Location': 'الموقع', 'Stage': 'المرحلة',
  'No projects have been entered. Customers who ask are told that the team will review their requirements; nothing is invented.': 'لم تُدخَل أي مشاريع. يُخبَر العملاء الذين يسألون بأن الفريق سيراجع متطلباتهم؛ ولا يُختلق أي شيء.',
  'Enter only facts you have verified. Customers see a project only while it is published; a draft or archived project is never shown or mentioned.': 'أدخل الحقائق التي تحققت منها فقط. لا يرى العملاء المشروع إلا وهو منشور؛ ولا تُعرض المسودة أو المشروع المؤرشف ولا يُذكران.',
  'Name (English)': 'الاسم (بالإنجليزية)', 'Name (Arabic)': 'الاسم (بالعربية)', 'City': 'المدينة', 'District / area': 'الحي / المنطقة', 'Property type': 'نوع العقار',
  'Summary (English)': 'الملخص (بالإنجليزية)', 'Summary (Arabic)': 'الملخص (بالعربية)', 'Brochure or approved picture (a customer-visible document: a PDF is sent as a file, an image as a picture)': 'كتيّب أو صورة معتمدة (مستند مرئي للعملاء: يُرسل ملف PDF كملف، والصورة كصورة)', 'None': 'لا شيء',
  // staff alert status (the banner above the real estate pages, the business profile field and the history of an enquiry)
  'Staff alerts are pending configuration.': 'تنبيهات الموظفين بانتظار الإعداد.',
  'No WhatsApp alert is sent for new enquiries or consultation requests until an internal staff number is set in Business Profile. Enquiries are still saved here.': 'لا يُرسل أي تنبيه واتساب للاستفسارات الجديدة أو طلبات الاستشارة إلى أن يُحدَّد رقم داخلي للموظفين في ملف النشاط. تُحفظ الاستفسارات هنا مع ذلك.',
  'Open Business Profile': 'فتح ملف النشاط',
  'Staff alerts: an internal staff number is configured.': 'تنبيهات الموظفين: تم إعداد رقم داخلي للموظفين.',
  'The queue retries automatically with back-off, and alerts leave only while this WhatsApp account is connected.': 'تُعيد قائمة الإرسال المحاولة تلقائياً بفواصل متزايدة، ولا تُرسل التنبيهات إلا أثناء اتصال حساب واتساب هذا.',
  'Staff alert not sent (no staff number)': 'لم يُرسل تنبيه للموظفين (لا يوجد رقم للموظفين)', 'Staff alert queued': 'أُضيف تنبيه الموظفين إلى قائمة الإرسال',
  'Internal: where new-enquiry and consultation alerts go. Never shown to customers and not the published business number. Until it is set, no WhatsApp alert is sent anywhere (enquiries are still saved in the dashboard).': 'داخلي: الجهة التي تصلها تنبيهات الاستفسارات الجديدة والاستشارات. لا يظهر للعملاء وليس رقم النشاط المنشور. إلى أن يُحدَّد لا يُرسل أي تنبيه واتساب إلى أي جهة (وتُحفظ الاستفسارات في لوحة التحكم).',
  'Published (customers can see and ask about it)': 'منشور (يمكن للعملاء رؤيته والسؤال عنه)', 'Save project': 'حفظ المشروع', 'Cancel': 'إلغاء', 'Restore': 'استعادة', 'Archive': 'أرشفة',
  'Project saved.': 'تم حفظ المشروع.', 'Project updated.': 'تم تحديث المشروع.',
  // follow-ups and documents
  'Enquiries to follow up': 'استفسارات للمتابعة', 'Nothing needs a person right now.': 'لا شيء يحتاج إلى موظف الآن.', 'Consultation requests': 'طلبات الاستشارة', 'No consultation requests.': 'لا توجد طلبات استشارة.',
  'A consultation is only a request until a member of the team confirms it with the customer (use Appointments to change its status).': 'الاستشارة مجرد طلب إلى أن يؤكدها أحد أعضاء الفريق مع العميل (استخدم «المواعيد» لتغيير حالتها).',
  'Topic': 'الموضوع', 'Preferred day and contact': 'اليوم المفضل وطريقة التواصل',
  'Receiving a file does not verify it. Please ask customers to send sensitive documents only through the secure process your advisors explain.': 'استلام الملف لا يعني التحقق منه. يرجى أن تطلب من العملاء إرسال المستندات الحساسة فقط عبر العملية الآمنة التي يشرحها مستشاروكم.',
  'Document status': 'حالة المستند',
  'No documents have been received from customers with an enquiry.': 'لم تُستلم مستندات من عملاء لديهم استفسار.', 'Nothing needs a person right now. ': 'لا شيء يحتاج إلى موظف الآن.',
  // what an enquiry records (field names) and its history events
  'Purpose (own use / rental / investment)': 'الغرض (سكن / تأجير / استثمار)', 'Budget': 'الميزانية', 'Currency': 'العملة', 'Bedrooms': 'عدد الغرف', 'Completed or off-plan': 'جاهز أو على الخارطة',
  'Payment / financing': 'الدفع / التمويل', 'Timeframe': 'الإطار الزمني', 'Ownership status': 'حالة الملكية', 'Authorised to sell': 'مخوَّل بالبيع', 'Expected asking price': 'السعر المتوقع',
  'Occupancy / completion': 'الإشغال / الإنجاز', 'Wants (valuation / marketing / brokerage)': 'يرغب في (تقييم / تسويق / وساطة)', 'Preferred callback time': 'وقت الاتصال المفضل',
  'Preferred contact method': 'طريقة التواصل المفضلة', 'Notes': 'ملاحظات', 'Name': 'الاسم',
  'created': 'إنشاء', 'updated': 'تحديث', 'status': 'الحالة', 'assigned': 'إسناد', 'documents': 'المستندات', 'note': 'ملاحظة',
});
window.I18N_AR_PATTERNS.push(
  [/^connected · (\d+) needs? attention$/, function (n) { return 'متصل · ' + n + ' تحتاج إلى انتباه'; }],
  [/^(\d+) open enquir(?:y was|ies were) saved without an alert\.$/, function (n) { return 'حُفظ ' + n + ' استفسار مفتوح دون إرسال تنبيه.'; }],
  [/^Delivery queue: (\d+) waiting, (\d+) delivered, (\d+) failed\.$/, function (p, s, f) { return 'قائمة الإرسال: ' + p + ' بالانتظار، ' + s + ' تم تسليمها، ' + f + ' فشلت.'; }],
  [/^(\d+) enquir(?:y|ies)$/, function (n) { return n + ' استفسار'; }],
  [/^Missing: (.+)$/, function (list) { return 'ناقص: ' + list.split(', ').map(function (x) { return window.I18N.lookup(x) || x; }).join('، '); }],
  [/^Still to ask: (.+)$/, function (list) { return 'ما يزال مطلوباً: ' + list.split(', ').map(function (x) { return window.I18N.lookup(x) || x; }).join('، '); }]
);

// Workspace redesign (v3): quick search, home hero and charts, build identifier, environment banner and the conversation composer.
Object.assign(window.I18N_AR, {
  'Search…': 'بحث…', 'Quick search': 'بحث سريع', 'Search pages, accounts and actions…': 'ابحث في الصفحات والحسابات والإجراءات…',
  'Results': 'النتائج', 'Pages': 'الصفحات', 'Actions': 'الإجراءات',
  'navigate': 'تنقّل', 'select': 'اختيار', 'close': 'إغلاق',
  'Switch to dark appearance': 'التبديل إلى المظهر الداكن', 'Switch to light appearance': 'التبديل إلى المظهر الفاتح',
  'Switch to Arabic': 'التبديل إلى العربية', 'Switch to English': 'التبديل إلى الإنجليزية', 'No results for': 'لا توجد نتائج لـ',
  'All clear': 'كل شيء على ما يرام', 'System': 'النظام', 'System status': 'حالة النظام',
  'Connections': 'الاتصالات', 'AI & automation': 'الذكاء الاصطناعي والأتمتة', 'View': 'عرض',
  'All accounts connected': 'جميع الحسابات متصلة',
  'Staff queue': 'قائمة انتظار الموظفين',
  'live from the database': 'مباشر من قاعدة البيانات',
  'Open inbox': 'فتح صندوق المحادثات', 'Reply activity': 'نشاط الردود', 'Live': 'مباشر',
  'Activity period': 'فترة النشاط', 'Replies by kind': 'الردود حسب النوع', 'Automatic replies': 'الردود التلقائية', 'Menu': 'القائمة', 'Conversations by handling': 'المحادثات حسب المعالجة',
  'same as yesterday': 'مثل الأمس', 'Replies sent': 'الردود المرسلة',
  'View all activity': 'عرض كل النشاط', 'Pending now': 'قيد الانتظار الآن', 'To staff': 'إلى الموظفين',
  'No replies yet': 'لا توجد ردود بعد',
  'AI active': 'الذكاء الاصطناعي نشط', 'Handled': 'تمت معالجتها',
  'Live application database': 'قاعدة بيانات التطبيق المباشرة',
  'Build: not stamped': 'الإصدار: غير موسوم',
  'Local window': 'نافذة محلية', 'Isolated local environment': 'بيئة محلية معزولة',
  'Data: PRODUCTION (live), read-only': 'البيانات: الإنتاج (مباشرة)، للقراءة فقط',
  'Data: PRODUCTION (live), business content editable': 'البيانات: الإنتاج (مباشرة)، ويمكن تعديل محتوى النشاط',
  'Own local database, not production data': 'قاعدة بيانات محلية خاصة، وليست بيانات الإنتاج',
  'Today': 'اليوم', 'Yesterday': 'أمس'
});
window.I18N_AR_PATTERNS.push(
  [/^(\d+) things? need attention$/, function (n) { return Number(n) === 1 ? 'أمر واحد يحتاج إلى انتباه' : n + ' أمور تحتاج إلى انتباه'; }],
  [/^(\d+) customer requests? waiting$/, function (n) { return n + ' طلب عميل بانتظار المعالجة'; }],
  [/^(\d+) of (\d+) WhatsApp accounts? (?:connected|online)$/, function (a, b) { return a + ' من ' + b + ' حساب واتساب متصل'; }],
  [/^\+(\d+) more$/, function (n) { return '+' + n + ' أخرى'; }],
  [/^(\d+)\/(\d+) connected$/, function (a, b) { return a + '/' + b + ' متصل'; }],
  [/^(\d+) waiting$/, function (n) { return n + ' بانتظار'; }],
  [/^([+\u2212])(\d+) vs yesterday$/, function (s, n) { return s + n + ' مقارنةً بالأمس'; }],
  [/^With (.+)$/, function (who) { return 'مع ' + who; }],
  [/^Build ([0-9a-zA-Z]{4,40})$/, function (c) { return 'الإصدار ' + c; }],
  [/^UI from commit (\S+)(?: \((.+)\))?( \+ uncommitted changes)?$/, function (c, b, u) { return 'الواجهة من الإصدار ' + c + (b ? ' (' + b + ')' : '') + (u ? ' + تغييرات غير مُثبَّتة' : ''); }],
  [/^Replies (today|yesterday|weekly)$/, function (k) { return { today: 'ردود اليوم', yesterday: 'ردود الأمس', weekly: 'ردود الأسبوع' }[k]; }],
  [/^(\d+)% of automatic replies came from the AI$/, function (n) { return n + '% من الردود التلقائية جاءت من الذكاء الاصطناعي'; }],
  [/^(Conversations by handling|Requests|Automatic replies): (.+)$/, function (head, body) {
    var L = window.I18N.lookup;
    var parts = body.split(', ').map(function (seg) { var m = /^(.+) (\d+)$/.exec(seg); return m ? (L(m[1]) || m[1]) + ' ' + m[2] : seg; });
    return (L(head) || head) + ': ' + parts.join('، ');
  }],
  [/^(.+): (QR code needed|Connected|Connecting|Disconnected|Connection error|Disabled)$/, function (name, state) { return name + ': ' + (window.I18N.lookup(state) || state); }],  [/^(.+): (\d+)$/, function (what, n) { var ar = window.I18N.lookup(what); return ar && ar !== what ? ar + ': ' + n : null; }]
);

// AI engine (v4): vision model, reply-language override and their help texts on the Providers page.
Object.assign(window.I18N_AR, {
  'Vision model (customer pictures)': 'نموذج الرؤية (صور العملاء)',
  'Reply language override': 'تجاوز لغة الرد',
  'The model that is shown the actual photo a customer sends, so the assistant identifies what is in it (a car, a part, a label) before answering. It must accept image input. Saving tests it with one tiny picture; if it cannot take pictures, photos are not analysed and the assistant says it could not open them instead of guessing.': 'النموذج الذي تُعرض عليه الصورة الفعلية التي يرسلها العميل ليحدّد المساعد ما فيها (سيارة، قطعة، ملصق) قبل الإجابة. يجب أن يقبل إدخال الصور. يختبره الحفظ بصورة صغيرة جداً؛ وإن لم يقبل الصور فلن تُحلَّل الصور وسيقول المساعد إنه تعذّر فتحها بدلاً من التخمين.',
  'Leave EMPTY for the shared rule every business uses: the assistant answers in the language of the customer\'s latest message (Arabic, English, Malayalam, Chinese, French, …) and switches when the customer switches. Enter a code such as ar or en only if this business must always reply in that one language.': 'اتركه فارغاً للقاعدة المشتركة بين جميع الأنشطة: يجيب المساعد بلغة آخر رسالة للعميل (العربية، الإنجليزية، المالايالامية، الصينية، الفرنسية، …) ويتحوّل حين يتحوّل العميل. أدخل رمزاً مثل ar أو en فقط إذا كان هذا النشاط يجب أن يرد دائماً بلغة واحدة.'
});

// Live sync footer and the isolated-environment banner.
Object.assign(window.I18N_AR, {
  'Syncing…': 'جارٍ المزامنة…', 'Sync failed — retrying': 'فشلت المزامنة — تجري إعادة المحاولة',
  'Isolated local environment': 'بيئة محلية معزولة'
});
window.I18N_AR_PATTERNS.push(
  [/^Live · synced (just now|\d+ s ago|\d+ min ago)$/, function (when) { var m = /^(\d+) (s|min) ago$/.exec(when); return 'مباشر · تمت المزامنة ' + (when === 'just now' ? 'الآن' : 'منذ ' + m[1] + (m[2] === 's' ? ' ث' : ' د')); }],
  [/^Stale — last synced (just now|\d+ s ago|\d+ min ago)$/, function (when) { var m = /^(\d+) (s|min) ago$/.exec(when); return 'قديم — آخر مزامنة ' + (when === 'just now' ? 'الآن' : 'منذ ' + m[1] + (m[2] === 's' ? ' ث' : ' د')); }],
  [/^Sync error — last synced (just now|\d+ s ago|\d+ min ago), retrying$/, function (when) { var m = /^(\d+) (s|min) ago$/.exec(when); return 'خطأ في المزامنة — آخر مزامنة ' + (when === 'just now' ? 'الآن' : 'منذ ' + m[1] + (m[2] === 's' ? ' ث' : ' د')) + '، تجري إعادة المحاولة'; }]
);
