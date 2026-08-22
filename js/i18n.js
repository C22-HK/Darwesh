// ---------------------------------------------------------------------
// Darwesh Group i18n — English / Kurdish (Sorani) / Arabic
//
// English text lives directly in the HTML and is never stored here —
// it's cached from the DOM the first time a page translates away from
// it, then restored when the visitor switches back to English. Only
// Kurdish and Arabic strings are kept in the dictionaries below, keyed
// by the same data-i18n value used in the markup.
//
// AI-translated (Sorani Kurdish + Modern Standard Arabic) — good
// enough to ship, but worth a native-speaker pass before a big public
// push.
// ---------------------------------------------------------------------

const I18N_KEY = 'darwesh_lang';
const RTL_LANGS = ['ku', 'ar'];

const translations = {
  ku: {
    'nav.home': 'سەرەکی',
    'nav.map': 'نەخشە',
    'nav.services': 'خزمەتگوزاریەکان',
    'nav.buy': 'کڕین',
    'nav.rent': 'کرێ',
    'nav.sell': 'فرۆشتن',
    'nav.build': 'بنیادنان',
    'nav.renovate': 'نۆژەنکردنەوە',
    'nav.insights': 'شیکاری بازاڕ',
    'nav.backToSite': 'گەڕانەوە بۆ ماڵپەڕ',
    'nav.signIn': 'چوونەژوورەوە',
    'nav.createAccount': 'دروستکردنی هەژمار',

    'common.search': 'گەڕان',
    'common.filters': 'پاڵاوتن',
    'common.details': 'وردەکاری',
    'common.viewAll': 'بینینی هەموو',
    'common.verified': 'پشتڕاستکراو',
    'common.loading': 'باربوونە...',
    'common.save': 'پاشەکەوتکردن',
    'common.cancel': 'هەڵوەشاندنەوە',
    'common.beds': 'ژووری نوستن',
    'common.baths': 'حەمام',
    'common.forSale': 'بۆ فرۆشتن',
    'common.forRent': 'بۆ کرێ',

    'index.searchPlaceholder': 'گەڕان بۆ خانووبەرە لە عێراق و کوردستان...',
    'index.aiSearch': 'گەڕانی زیرەک',
    'index.heroLine1': 'خانووبەرەی تایبەت.',
    'index.heroLine2': 'زانیاری پشتڕاستکراو.',
    'index.buy': 'کڕین',
    'index.rent': 'کرێ',
    'index.build': 'بنیادنان',
    'index.renovate': 'نۆژەنکردنەوە',
    'index.featuredTitle': 'خانووبەرەی تایبەت',
    'index.featuredSubtitle': 'هەڵبژێردراو و پشتڕاستکراو لەلایەن دەرەوشی گروپەوە.',
    'index.viewAll': 'بینینی هەموو',
    'index.exclusiveOffer': 'دەرفەتی تایبەت',
    'index.discountTitle': 'سکان بکە بۆ ١٠٪ داشکاندن لە کرێی دلالی',
    'index.discountBody': 'کۆدی QR بە کامێرای مۆبایلەکەت سکان بکە بۆ بینینی کۆدی داشکاندنەکەت، یان بە ئۆنلاین سەیری بکە.',
    'index.viewOfferOnline': 'بینینی دەرفەتەکە بە ئۆنلاین',
    'index.mamBadge': 'زیرەکی MAM AI',
    'index.mamTitle': 'بازاڕ بە دڵنیاییەوە بگەڕێ.',
    'index.mamBody': 'هەر شتێک دەربارەی بازاڕ لە MAM بپرسە. نرخاندنی ڕاستەوخۆ، تێڕوانینی وەبەرهێنان و زانیاری گەڕەک لەخۆ وەربگرە.',
    'index.startConversation': 'دەستپێکردنی گفتوگۆ',

    'map.title': 'نەخشەی خانووبەرە',
    'map.pageTitle': 'خانووبەرەکانی هەرێمی کوردستان',
    'map.searchCity': 'گەڕان بەپێی شار یان ناونیشان',
    'map.drawArea': 'ناوچە بکێشە',
    'map.myLocation': 'شوێنی من',
    'map.clearSearch': 'گەڕان پاک بکەرەوە',
    'map.allTypes': 'هەموو جۆرەکان',
    'map.villa': 'ڤیلا',
    'map.apartment': 'ئاپارتمان',
    'map.office': 'ئۆفیس',
    'map.land': 'زەوی',
    'map.privateListing': 'خانووبەرەی تایبەت',
    'map.saveSearch': 'پاشەکەوتکردنی گەڕان',
    'map.locationHidden': 'شوێن شاراوەیە',
    'map.approximateArea': 'ناوچەی نزیک',
    'map.requestViewing': 'داوای بینین بکە',
    'map.exactLocation': 'شوێنی وردی بینین',
    'map.verifiedByDarwesh': 'پشتڕاستکراوە لەلایەن دەرەوش گروپەوە',
    'map.priceLabel': 'نرخ',
    'map.bedsAndBaths': 'ژووری نوستن و حەمام',
    'map.homeType': 'جۆری خانوو',
    'map.searchAreaActive': 'ناوچەی گەڕان چالاکە',
    'map.all': 'هەموو',

    'buy.title': 'کڕینی خانووبەرە',
    'buy.subtitle': 'خانووبەرەی پشتڕاستکراو بۆ فرۆشتن لە سەرانسەری کوردستان، پشتگیریکراو بە دڵنیایی دەرەوش گروپ.',
    'buy.allCities': 'هەموو شارەکان',
    'buy.sortBy': 'ڕیزکردن بەپێی',
    'buy.priceLowHigh': 'نرخ: کەم بۆ زۆر',
    'buy.priceHighLow': 'نرخ: زۆر بۆ کەم',
    'buy.newest': 'نوێترین',
    'buy.buyTab': 'کڕین',
    'buy.sellTab': 'فرۆشتن',
    'buy.searchPlaceholder': 'گەڕان بەپێی شار یان گەڕەک...',
    'buy.allHomeTypes': 'هەموو جۆرەکانی خانوو',
    'buy.sortFeatured': 'ڕیزکردن: تایبەت',
    'buy.viewOnMap': 'بینین لەسەر نەخشە',
    'buy.noResults': 'هیچ خانووبەرەیەک لەگەڵ گەڕانەکەت ناگونجێت. شار یان جۆرێکی تر تاقی بکەرەوە.',

    'rent.title': 'کرێی خانووبەرە',
    'rent.subtitle': 'خانووبەرەی پشتڕاستکراو بۆ کرێ لە سەرانسەری کوردستان.',
    'rent.monthlyRent': 'کرێی مانگانە',
    'rent.portfolioTitle': 'پۆرتفۆلیۆی کرێ',
    'rent.portfolioSubtitle': 'بەڕێوەبردنی کرێکانی تایبەت و داواکاریەکانت.',

    'sell.title': 'خانووبەرەکەت بفرۆشە',
    'sell.subtitle': 'لەگەڵ دەرەوش گروپ لیست بکە و بگەڕێ بۆ کڕیارانی پشتڕاستکراو لە سەرانسەری هەرێمی کوردستان.',
    'sell.propertyTitle': 'ناونیشانی خانووبەرە',
    'sell.address': 'ناونیشان',
    'sell.city': 'شار',
    'sell.propertyType': 'جۆری خانووبەرە',
    'sell.dealType': 'جۆری مامەڵە',
    'sell.price': 'نرخ (بە دۆلار)',
    'sell.beds': 'ژووری نوستن',
    'sell.baths': 'حەمام',
    'sell.size': 'ڕووبەر (م²)',
    'sell.description': 'وەسف',
    'sell.contactName': 'ناوی پەیوەندیکردن',
    'sell.contactPhone': 'ژمارەی مۆبایل',
    'sell.submit': 'ناردنی داواکاری',

    'sell.savedDraft': 'ڕەشنووسێکی پاشەکەوتکراوت هەیە.',
    'sell.restore': 'گەڕاندنەوە',
    'sell.discard': 'پشتگوێخستن',
    'sell.propertyDetails': 'وردەکاری خانووبەرە',
    'sell.titlePlaceholder': 'بۆ نموونە: ڤیلای مۆدێرن لە گوندی ئیتاڵی',
    'sell.selectType': 'جۆر هەڵبژێرە',
    'sell.retailShop': 'دوکانی بازرگانی',
    'sell.listingType': 'جۆری لیست',
    'sell.selectCity': 'شار هەڵبژێرە',
    'sell.neighborhoodAddress': 'گەڕەک / ناونیشان',
    'sell.addressPlaceholder': 'بۆ نموونە: گوندی ئیتاڵی',
    'sell.pinExactLocation': 'شوێنی وردی نیشانبدە',
    'sell.clickMapToPin': 'کلیک لەسەر نەخشە بکە بۆ دانانی نیشانە',
    'sell.askingPrice': 'نرخی داواکراو (بە دۆلار)',
    'sell.pricePlaceholder': 'بۆ نموونە: 250000',
    'sell.sizePlaceholder': 'بۆ نموونە: 220',
    'sell.bedrooms': 'ژووری نوستن',
    'sell.bathrooms': 'حەمامەکان',
    'sell.descriptionPlaceholder': 'خانووبەرەکە، دۆخەکەی و تایبەتمەندیە بەرچاوەکانی وەسف بکە...',
    'sell.photosFloorPlans': 'وێنە و پلانی نەخشەسازی',
    'sell.uploadPhotos': 'بارکردنی وێنە و پلانی نەخشەسازی',
    'sell.dragDrop': 'ڕایبکێشە و دایبنێ یان کلیک بکە بۆ گەڕان',
    'sell.contactInfo': 'زانیاری پەیوەندیکردنت',
    'sell.fullName': 'ناوی تەواو',
    'sell.phoneNumber': 'ژمارەی مۆبایل',
    'sell.saveDraft': 'پاشەکەوتکردنی ڕەشنووس',
    'sell.submitForVerification': 'ناردن بۆ پشتڕاستکردنەوە',
    'sell.reviewNote': 'ئەیجێنتێکی دەرەوش گروپ لیستەکەت پێداچوونەوەی بۆ دەکات و لە ماوەی ٢٤ کاتژمێردا پەیوەندیت پێوە دەکات.',
    'sell.listingSubmitted': 'لیستەکە نێردرا',
    'sell.confirmationBody': 'سوپاس. ئەیجێنتێکی دەرەوش گروپ زانیاریەکانت پشتڕاست دەکاتەوە و لە ماوەی ٢٤ کاتژمێردا پەیوەندیت پێوە دەکات بۆ ڕێکخستنی وێنەگرتن و تەواوکردنی لیستەکەت.',
    'sell.backToHome': 'گەڕانەوە بۆ سەرەکی',
    'sell.whySell': 'بۆچی لەگەڵ دەرەوش گروپ بفرۆشیت؟',
    'sell.whySellBody': 'بگەڕێ بۆ تۆڕێکی پشتڕاستکراوی کڕیاران، پشتگیریکراو بە زیرەکی PropTech.',
    'sell.benefit1': 'بازاڕی کڕیاری پشتڕاستکراو',
    'sell.benefit2': 'نرخاندن بە هێزی MAM AI',
    'sell.benefit3': 'ئەیجێنتی تایبەتی پۆرتفۆلیۆ',
    'sell.benefit4': 'وێنەگرتنی پیشەیی لەخۆدەگرێت',

    'cities.erbil': 'هەولێر',
    'cities.sulaymaniyah': 'سلێمانی',
    'cities.duhok': 'دهۆک',
    'cities.zakho': 'زاخۆ',
    'cities.soran': 'سۆران',
    'cities.koya': 'کۆیە',
    'cities.halabja': 'هەڵەبجە',

    'services.title': 'خزمەتگوزاریەکانی دەرەوش',
    'services.subtitle': 'سیستەمێکی تەواو بۆ هەموو پێداویستیەکانی خانووبەرەت.',
    'services.coreCapabilities': 'توانا سەرەکیەکان',
    'services.buying': 'کڕین و فرۆشتن',
    'services.buyingDesc': 'بازاڕی خانووبەرەی تایبەت کە کڕیار و فرۆشیاری پشتڕاستکراو بە یەکتر دەبەستێتەوە.',

    'services.heroSubtitle': 'سیستەمێکی تەواو بۆ هەموو پێداویستیەکانی خانووبەرەت، بەیەکەوە دەبەستێتەوە بەهاکانی نەریتی خانووبەرە لەگەڵ داهێنانی PropTech.',
    'services.buyingTitle': 'کڕین و فرۆشتن',
    'services.buyingDesc2': 'بازاڕی خانووبەرەی تایبەت کە کڕیار و فرۆشیاری پشتڕاستکراو بە یەکتر دەبەستێتەوە.',
    'services.landTitle': 'مامەڵەی زەوی',
    'services.landDesc': 'کڕینی ستراتیژی زەوی نیشتەجێبوون، بازرگانی و وەبەرهێنان.',
    'services.residentialTitle': 'پرۆژە نیشتەجێبوونەکان',
    'services.residentialDesc': 'ئاپارتمانی تایبەت و پلاندانانی گەشەپێدانی نوێی تەواو.',
    'services.commercialTitle': 'خانووبەرەی بازرگانی',
    'services.commercialDesc': 'شوێنی ئۆفیس و وەبەرهێنانی دوکانی بازرگانی بە قازانجی بەرز.',
    'services.constructionTitle': 'بنیادنان',
    'services.constructionDesc': 'باشترین کارامەیی لە دیزاین-بنیادنان و گرێبەستکردن.',
    'services.interiorTitle': 'دیزاینی ناوەوە',
    'services.interiorDesc': 'پلاندانانی پیشەیی ماڵ و ڕازاندنەوەی ناوەوەی تایبەت.',
    'services.managementTitle': 'بەڕێوەبردنی خانووبەرە',
    'services.managementDesc': 'چاککردنەوە، پاکژکردنەوە و پەیوەندی لەگەڵ دانیشتووان بە تەواوی.',
    'services.investmentTitle': 'خزمەتگوزاری وەبەرهێنان',
    'services.investmentDesc': 'شیکاری قووڵی بازاڕ و ستراتیژی باشترکردنی ROI.',

    'services.smartMapBadge': 'زیرەکی PropTech',
    'services.smartMapTitle': 'نەخشەی زیرەکی خانووبەرە',
    'services.smartMapBody': 'زیرەکی شوێنی بینین بکە. \'گەڕانی کێشراو\' بەکاربهێنە بۆ دیاریکردنی سنووری تایبەت، و پێوانەی دووری ڕاستەوخۆ بۆ قوتابخانە، نەخۆشخانە و بنکەخانەی گرنگ ببینە.',
    'services.openMap': 'کردنەوەی نەخشەی کارلێکراو',
    'services.mamTitle': 'لە MAM AI بپرسە',
    'services.mamBody': 'ڕاسپاردەی خانووبەرەی تایبەت و بەپشتبەستن بە داتا بە شێوەیەکی ڕاستەوخۆ وەربگرە.',
    'services.chatNow': 'ئێستا گفتوگۆ بکە',

    'auth.email': 'ئیمەیل',
    'auth.password': 'وشەی نهێنی',
    'auth.signIn': 'چوونەژوورەوە',
    'auth.createAccount': 'دروستکردنی هەژمار',
    'auth.fullName': 'ناوی تەواو',
    'auth.company': 'کۆمپانیا / بریکاری',
    'auth.forgotPassword': 'وشەی نهێنیت لەبیرچووە؟',
    'auth.noAccount': 'هەژمارت نیە؟',
    'auth.haveAccount': 'هەژمارت هەیە؟',
    'auth.logInTitle': 'چوونەژوورەوە',
    'auth.logInSubtitle': 'دەستگەیشتن بە دڵخوازەکان، ناردنەکان و گەڕانە پاشەکەوتکراوەکانت.',
    'auth.logInBtn': 'چوونەژوورەوە',
    'auth.signUpLink': 'خۆتۆمارکردن',
    'auth.signUpTitle': 'دروستکردنی هەژمار',
    'auth.signUpSubtitle': 'بۆ پاشەکەوتکردنی دڵخوازەکان، شوێنکەوتنی ناردنەکان و زیاتر خۆت تۆمار بکە.',
    'auth.signUpBtn': 'دروستکردنی هەژمار',
    'auth.logInLink': 'چوونەژوورەوە',
    'auth.companyHelp': 'زۆربەی خەڵک ئەمە بە دەرەوش گروپ جێدەهێڵن. ئەگەر بۆ کۆمپانیایەکی تر کاردەکەیت کە ئەم پلاتفۆرمە بەکاردەهێنێت، ناوی کۆمپانیاکە بنووسە.',
    'auth.minChars': 'لانیکەم ٦ پیت.',
    'auth.alreadyHaveAccount': 'هەژمارت هەیە؟'
  },
  ar: {
    'nav.home': 'الرئيسية',
    'nav.map': 'الخريطة',
    'nav.services': 'الخدمات',
    'nav.buy': 'شراء',
    'nav.rent': 'إيجار',
    'nav.sell': 'بيع',
    'nav.build': 'بناء',
    'nav.renovate': 'تجديد',
    'nav.insights': 'تحليلات السوق',
    'nav.backToSite': 'العودة إلى الموقع',
    'nav.signIn': 'تسجيل الدخول',
    'nav.createAccount': 'إنشاء حساب',

    'common.search': 'بحث',
    'common.filters': 'الفلاتر',
    'common.details': 'التفاصيل',
    'common.viewAll': 'عرض الكل',
    'common.verified': 'موثّق',
    'common.loading': 'جارٍ التحميل...',
    'common.save': 'حفظ',
    'common.cancel': 'إلغاء',
    'common.beds': 'غرف نوم',
    'common.baths': 'حمامات',
    'common.forSale': 'للبيع',
    'common.forRent': 'للإيجار',

    'index.searchPlaceholder': 'ابحث عن عقارات في العراق وكردستان...',
    'index.aiSearch': 'بحث ذكي',
    'index.heroLine1': 'عقارات مميزة.',
    'index.heroLine2': 'معلومات موثوقة.',
    'index.buy': 'شراء',
    'index.rent': 'إيجار',
    'index.build': 'بناء',
    'index.renovate': 'تجديد',
    'index.featuredTitle': 'عقارات مميزة',
    'index.featuredSubtitle': 'مختارة وموثقة من قبل مجموعة درويش.',
    'index.viewAll': 'عرض الكل',
    'index.exclusiveOffer': 'عرض حصري',
    'index.discountTitle': 'امسح للحصول على خصم 10% على رسوم الوساطة',
    'index.discountBody': 'امسح رمز QR بكاميرا هاتفك لإظهار كود الخصم الخاص بك، أو شاهده عبر الإنترنت.',
    'index.viewOfferOnline': 'مشاهدة العرض عبر الإنترنت',
    'index.mamBadge': 'ذكاء MAM AI',
    'index.mamTitle': 'تصفّح السوق بثقة تامة.',
    'index.mamBody': 'اسأل MAM عن أي شيء يخص السوق. احصل على تقييم فوري، ورؤى استثمارية، ومعلومات عن الأحياء بشكل لحظي.',
    'index.startConversation': 'ابدأ المحادثة',

    'map.title': 'خريطة العقارات',
    'map.pageTitle': 'عقارات إقليم كردستان',
    'map.searchCity': 'ابحث بالمدينة أو العنوان',
    'map.drawArea': 'ارسم منطقة',
    'map.myLocation': 'موقعي',
    'map.clearSearch': 'مسح البحث',
    'map.allTypes': 'جميع الأنواع',
    'map.villa': 'فيلا',
    'map.apartment': 'شقة',
    'map.office': 'مكتب',
    'map.land': 'أرض',
    'map.privateListing': 'عقار خاص',
    'map.saveSearch': 'حفظ البحث',
    'map.locationHidden': 'الموقع مخفي',
    'map.approximateArea': 'منطقة تقريبية',
    'map.requestViewing': 'طلب معاينة',
    'map.exactLocation': 'الموقع الدقيق',
    'map.verifiedByDarwesh': 'موثّق من قبل مجموعة درويش',
    'map.priceLabel': 'السعر',
    'map.bedsAndBaths': 'غرف النوم والحمامات',
    'map.homeType': 'نوع العقار',
    'map.searchAreaActive': 'منطقة البحث مفعّلة',
    'map.all': 'الكل',

    'buy.title': 'شراء عقار',
    'buy.subtitle': 'عقارات موثقة معروضة للبيع في جميع أنحاء كردستان، مدعومة بضمان الثقة من مجموعة درويش.',
    'buy.allCities': 'جميع المدن',
    'buy.sortBy': 'ترتيب حسب',
    'buy.priceLowHigh': 'السعر: من الأقل للأعلى',
    'buy.priceHighLow': 'السعر: من الأعلى للأقل',
    'buy.newest': 'الأحدث',
    'buy.buyTab': 'شراء',
    'buy.sellTab': 'بيع',
    'buy.searchPlaceholder': 'ابحث عن مدينة أو حي...',
    'buy.allHomeTypes': 'جميع أنواع العقارات',
    'buy.sortFeatured': 'ترتيب: مميز',
    'buy.viewOnMap': 'عرض على الخريطة',
    'buy.noResults': 'لا توجد عقارات مطابقة لبحثك. جرّب مدينة أو نوع عقار مختلف.',

    'rent.title': 'إيجار عقار',
    'rent.subtitle': 'عقارات موثقة معروضة للإيجار في جميع أنحاء كردستان.',
    'rent.monthlyRent': 'الإيجار الشهري',
    'rent.portfolioTitle': 'محفظة الإيجارات',
    'rent.portfolioSubtitle': 'إدارة إيجاراتك المميزة وطلباتك.',

    'sell.title': 'بيع عقارك',
    'sell.subtitle': 'أدرج عقارك مع مجموعة درويش وتواصل مع مشترين موثقين في جميع أنحاء إقليم كردستان.',
    'sell.propertyTitle': 'عنوان العقار',
    'sell.address': 'العنوان',
    'sell.city': 'المدينة',
    'sell.propertyType': 'نوع العقار',
    'sell.dealType': 'نوع الصفقة',
    'sell.price': 'السعر (دولار أمريكي)',
    'sell.beds': 'غرف نوم',
    'sell.baths': 'حمامات',
    'sell.size': 'المساحة (م²)',
    'sell.description': 'الوصف',
    'sell.contactName': 'اسم جهة الاتصال',
    'sell.contactPhone': 'رقم الهاتف',
    'sell.submit': 'إرسال الطلب',

    'sell.savedDraft': 'لديك مسودة محفوظة.',
    'sell.restore': 'استعادة',
    'sell.discard': 'تجاهل',
    'sell.propertyDetails': 'تفاصيل العقار',
    'sell.titlePlaceholder': 'مثال: فيلا حديثة في القرية الإيطالية',
    'sell.selectType': 'اختر النوع',
    'sell.retailShop': 'محل تجاري',
    'sell.listingType': 'نوع الإعلان',
    'sell.selectCity': 'اختر المدينة',
    'sell.neighborhoodAddress': 'الحي / العنوان',
    'sell.addressPlaceholder': 'مثال: القرية الإيطالية',
    'sell.pinExactLocation': 'حدد الموقع الدقيق',
    'sell.clickMapToPin': 'انقر على الخريطة لتثبيت الموقع',
    'sell.askingPrice': 'السعر المطلوب (دولار أمريكي)',
    'sell.pricePlaceholder': 'مثال: 250000',
    'sell.sizePlaceholder': 'مثال: 220',
    'sell.bedrooms': 'غرف النوم',
    'sell.bathrooms': 'الحمامات',
    'sell.descriptionPlaceholder': 'صف العقار وحالته وأبرز مميزاته...',
    'sell.photosFloorPlans': 'الصور ومخططات الطوابق',
    'sell.uploadPhotos': 'رفع الصور ومخططات الطوابق',
    'sell.dragDrop': 'اسحب وأفلت أو انقر للتصفح',
    'sell.contactInfo': 'معلومات التواصل الخاصة بك',
    'sell.fullName': 'الاسم الكامل',
    'sell.phoneNumber': 'رقم الهاتف',
    'sell.saveDraft': 'حفظ المسودة',
    'sell.submitForVerification': 'إرسال للتحقق',
    'sell.reviewNote': 'سيقوم أحد وكلاء مجموعة درويش بمراجعة إعلانك والتواصل معك خلال 24 ساعة.',
    'sell.listingSubmitted': 'تم إرسال الإعلان',
    'sell.confirmationBody': 'شكرًا لك. سيتحقق أحد وكلاء مجموعة درويش من بياناتك ويتواصل معك خلال 24 ساعة لتحديد موعد التصوير وإنهاء إعلانك.',
    'sell.backToHome': 'العودة إلى الرئيسية',
    'sell.whySell': 'لماذا تبيع مع مجموعة درويش؟',
    'sell.whySellBody': 'تواصل مع شبكة موثقة من المشترين مدعومة بذكاء تقنية العقارات.',
    'sell.benefit1': 'سوق مشترين موثّق',
    'sell.benefit2': 'تقييم مدعوم بذكاء MAM AI',
    'sell.benefit3': 'وكيل مخصص للمحفظة',
    'sell.benefit4': 'تصوير احترافي مشمول',

    'cities.erbil': 'أربيل',
    'cities.sulaymaniyah': 'السليمانية',
    'cities.duhok': 'دهوك',
    'cities.zakho': 'زاخو',
    'cities.soran': 'سوران',
    'cities.koya': 'كويە',
    'cities.halabja': 'حلبجة',

    'services.title': 'خدمات مجموعة درويش',
    'services.subtitle': 'منظومة متكاملة لكل احتياجاتك العقارية.',
    'services.coreCapabilities': 'القدرات الأساسية',
    'services.buying': 'الشراء والبيع',
    'services.buyingDesc': 'سوق عقاري متميز يربط المشترين والبائعين الموثقين.',

    'services.heroSubtitle': 'منظومة متكاملة لكل احتياجاتك العقارية، تجمع بين قيم العقارات التقليدية وابتكار تقنية العقارات.',
    'services.buyingTitle': 'الشراء والبيع',
    'services.buyingDesc2': 'سوق عقاري متميز يربط المشترين والبائعين الموثقين.',
    'services.landTitle': 'معاملات الأراضي',
    'services.landDesc': 'استحواذات استراتيجية على أراضٍ سكنية وتجارية واستثمارية.',
    'services.residentialTitle': 'المشاريع السكنية',
    'services.residentialDesc': 'شقق حصرية وتخطيط شامل للتطوير الجديد.',
    'services.commercialTitle': 'العقارات التجارية',
    'services.commercialDesc': 'مساحات مكتبية ومحلات تجارية عالية العائد.',
    'services.constructionTitle': 'البناء',
    'services.constructionDesc': 'تميّز شامل في التصميم والبناء والمقاولات.',
    'services.interiorTitle': 'التصميم الداخلي',
    'services.interiorDesc': 'تخطيط منزلي احترافي وتصميم داخلي مخصص.',
    'services.managementTitle': 'إدارة العقارات',
    'services.managementDesc': 'صيانة شاملة وتنظيف وعلاقات مع المستأجرين.',
    'services.investmentTitle': 'خدمات الاستثمار',
    'services.investmentDesc': 'تحليل عميق للسوق واستراتيجيات لتحسين العائد على الاستثمار.',

    'services.smartMapBadge': 'ذكاء تقنية العقارات',
    'services.smartMapTitle': 'خريطة العقارات الذكية',
    'services.smartMapBody': 'تصوّر الذكاء المكاني. استخدم \'رسم منطقة البحث\' لتحديد حدود مخصصة، وشاهد مقاييس المسافة الفورية إلى المدارس والمستشفيات والبنية التحتية المهمة.',
    'services.openMap': 'فتح الخريطة التفاعلية',
    'services.mamTitle': 'اسأل MAM AI',
    'services.mamBody': 'احصل على توصيات عقارية مخصصة ومبنية على البيانات فورًا.',
    'services.chatNow': 'ابدأ المحادثة الآن',

    'auth.email': 'البريد الإلكتروني',
    'auth.password': 'كلمة المرور',
    'auth.signIn': 'تسجيل الدخول',
    'auth.createAccount': 'إنشاء حساب',
    'auth.fullName': 'الاسم الكامل',
    'auth.company': 'الشركة / الوكالة',
    'auth.forgotPassword': 'هل نسيت كلمة المرور؟',
    'auth.noAccount': 'ليس لديك حساب؟',
    'auth.haveAccount': 'لديك حساب بالفعل؟',
    'auth.logInTitle': 'تسجيل الدخول',
    'auth.logInSubtitle': 'الوصول إلى مفضلاتك وطلباتك وعمليات البحث المحفوظة.',
    'auth.logInBtn': 'تسجيل الدخول',
    'auth.signUpLink': 'إنشاء حساب',
    'auth.signUpTitle': 'إنشاء حساب',
    'auth.signUpSubtitle': 'أنشئ حسابًا لحفظ المفضلات وتتبع طلباتك والمزيد.',
    'auth.signUpBtn': 'إنشاء حساب',
    'auth.logInLink': 'تسجيل الدخول',
    'auth.companyHelp': 'يترك معظم الأشخاص هذا الحقل كمجموعة درويش. إذا كنت تعمل لدى وكالة أخرى تستخدم هذه المنصة، أدخل اسمها.',
    'auth.minChars': '6 أحرف على الأقل.',
    'auth.alreadyHaveAccount': 'لديك حساب بالفعل؟'
  }
};

function getLang() {
  return localStorage.getItem(I18N_KEY) || 'en';
}

function applyTranslations(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL_LANGS.includes(lang) ? 'rtl' : 'ltr';

  const dict = translations[lang];

  document.querySelectorAll('[data-i18n]').forEach(el => {
    if (el.dataset.i18nOrig === undefined) el.dataset.i18nOrig = el.textContent;
    const key = el.getAttribute('data-i18n');
    el.textContent = (dict && dict[key]) ? dict[key] : el.dataset.i18nOrig;
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    if (el.dataset.i18nOrigPh === undefined) el.dataset.i18nOrigPh = el.getAttribute('placeholder') || '';
    const key = el.getAttribute('data-i18n-placeholder');
    el.setAttribute('placeholder', (dict && dict[key]) ? dict[key] : el.dataset.i18nOrigPh);
  });

  document.querySelectorAll('.lang-option').forEach(opt => {
    const active = opt.dataset.lang === lang;
    opt.style.color = active ? '#775a19' : '';
    opt.style.fontWeight = active ? '700' : '';
  });
}

window.setLanguage = function (lang) {
  localStorage.setItem(I18N_KEY, lang);
  applyTranslations(lang);
  document.querySelectorAll('.lang-menu').forEach(m => m.classList.add('hidden'));
  document.dispatchEvent(new CustomEvent('darwesh:langchange', { detail: { lang } }));
};

window.t = function (key) {
  const dict = translations[getLang()];
  return (dict && dict[key]) || null;
};

document.addEventListener('DOMContentLoaded', () => {
  applyTranslations(getLang());

  document.querySelectorAll('.lang-toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector('.lang-menu');
      document.querySelectorAll('.lang-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
      if (menu) menu.classList.toggle('hidden');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.lang-menu').forEach(m => m.classList.add('hidden'));
  });
});
