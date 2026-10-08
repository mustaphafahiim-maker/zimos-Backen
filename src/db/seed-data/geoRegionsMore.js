'use strict';

/**
 * The platform's place list (SPEC §12.1) for the other countries a store
 * sells in (storeCountry.js), added to geo_regions by migration 532 next to
 * Egypt and Saudi Arabia (geoRegions.js, migration 403):
 *
 *   MA  the 12 regions of 2015
 *   DZ  the 58 wilayas (the 48, plus the 10 of law 19-12 of 2019, 49–58)
 *   AE  the 7 emirates
 *   KW  the 6 governorates
 *   JO  the 12 governorates
 *   LY  the 22 districts (shabiyat, 2007), which ISO and the couriers still use
 *   PS  the 16 governorates
 *   TN  the 24 governorates
 *   IQ  the 18 governorates, plus Halabja (Kurdistan Region, 2014; federal 2025)
 *   QA  the 8 municipalities
 *   BH  the 4 governorates (since 2014)
 *   OM  the 11 governorates
 *
 * A division's code is its ISO 3166-2 code in lower case (`ma-06`, `ae-du`,
 * `dz-16`); Halabja, which has none, is `iq-halabja`. A city is
 * `<division>.<slug>`. Codes never change once shipped: stores keep them in
 * their prices (shipping_governorate_rates) and courier maps.
 *
 * Cities: each division's capital, and the large towns and districts orders
 * go to, only where the name and the division it sits in are certain. A
 * merchant adds the rest to their own list (store places).
 *
 * Each entry is [code suffix, Arabic name, English name, cities], each city
 * [slug, Arabic name, English name]. Names are as written in the country;
 * Maghreb towns keep their French spelling (Fès, Sétif), with the common
 * English forms as aliases (geo/geoRegions.js).
 */

const MOROCCO = [
  ['06', 'الدار البيضاء سطات', 'Casablanca-Settat', [
    ['casablanca', 'الدار البيضاء', 'Casablanca'],
    ['mohammedia', 'المحمدية', 'Mohammedia'],
    ['el-jadida', 'الجديدة', 'El Jadida'],
    ['settat', 'سطات', 'Settat'],
    ['berrechid', 'برشيد', 'Berrechid'],
    ['benslimane', 'بنسليمان', 'Benslimane'],
    ['sidi-bennour', 'سيدي بنور', 'Sidi Bennour'],
    ['bouskoura', 'بوسكورة', 'Bouskoura'],
  ]],
  ['04', 'الرباط سلا القنيطرة', 'Rabat-Salé-Kénitra', [
    ['rabat', 'الرباط', 'Rabat'],
    ['sale', 'سلا', 'Salé'],
    ['kenitra', 'القنيطرة', 'Kénitra'],
    ['temara', 'تمارة', 'Témara'],
    ['skhirat', 'الصخيرات', 'Skhirat'],
    ['khemisset', 'الخميسات', 'Khémisset'],
    ['tiflet', 'تيفلت', 'Tiflet'],
    ['sidi-kacem', 'سيدي قاسم', 'Sidi Kacem'],
    ['sidi-slimane', 'سيدي سليمان', 'Sidi Slimane'],
  ]],
  ['01', 'طنجة تطوان الحسيمة', 'Tanger-Tétouan-Al Hoceïma', [
    ['tanger', 'طنجة', 'Tangier'],
    ['tetouan', 'تطوان', 'Tétouan'],
    ['al-hoceima', 'الحسيمة', 'Al Hoceïma'],
    ['larache', 'العرائش', 'Larache'],
    ['ksar-el-kebir', 'القصر الكبير', 'Ksar El Kébir'],
    ['chefchaouen', 'شفشاون', 'Chefchaouen'],
    ['ouazzane', 'وزان', 'Ouazzane'],
    ['fnideq', 'الفنيدق', 'Fnideq'],
    ['mdiq', 'المضيق', "M'diq"],
    ['asilah', 'أصيلة', 'Asilah'],
  ]],
  ['03', 'فاس مكناس', 'Fès-Meknès', [
    ['fes', 'فاس', 'Fès'],
    ['meknes', 'مكناس', 'Meknès'],
    ['taza', 'تازة', 'Taza'],
    ['ifrane', 'إفران', 'Ifrane'],
    ['azrou', 'أزرو', 'Azrou'],
    ['sefrou', 'صفرو', 'Sefrou'],
    ['el-hajeb', 'الحاجب', 'El Hajeb'],
    ['taounate', 'تاونات', 'Taounate'],
  ]],
  ['07', 'مراكش آسفي', 'Marrakech-Safi', [
    ['marrakech', 'مراكش', 'Marrakech'],
    ['safi', 'آسفي', 'Safi'],
    ['essaouira', 'الصويرة', 'Essaouira'],
    ['el-kelaa-des-sraghna', 'قلعة السراغنة', 'El Kelaâ des Sraghna'],
    ['youssoufia', 'اليوسفية', 'Youssoufia'],
    ['benguerir', 'ابن جرير', 'Benguerir'],
    ['chichaoua', 'شيشاوة', 'Chichaoua'],
  ]],
  ['02', 'الشرق', 'Oriental', [
    ['oujda', 'وجدة', 'Oujda'],
    ['nador', 'الناظور', 'Nador'],
    ['berkane', 'بركان', 'Berkane'],
    ['taourirt', 'تاوريرت', 'Taourirt'],
    ['guercif', 'جرسيف', 'Guercif'],
    ['jerada', 'جرادة', 'Jerada'],
    ['driouch', 'الدريوش', 'Driouch'],
    ['figuig', 'فجيج', 'Figuig'],
  ]],
  ['05', 'بني ملال خنيفرة', 'Béni Mellal-Khénifra', [
    ['beni-mellal', 'بني ملال', 'Béni Mellal'],
    ['khouribga', 'خريبكة', 'Khouribga'],
    ['khenifra', 'خنيفرة', 'Khénifra'],
    ['fquih-ben-salah', 'الفقيه بن صالح', 'Fquih Ben Salah'],
    ['azilal', 'أزيلال', 'Azilal'],
    ['kasba-tadla', 'قصبة تادلة', 'Kasba Tadla'],
    ['oued-zem', 'وادي زم', 'Oued Zem'],
  ]],
  ['09', 'سوس ماسة', 'Souss-Massa', [
    ['agadir', 'أكادير', 'Agadir'],
    ['inezgane', 'إنزكان', 'Inezgane'],
    ['ait-melloul', 'أيت ملول', 'Aït Melloul'],
    ['taroudant', 'تارودانت', 'Taroudant'],
    ['tiznit', 'تيزنيت', 'Tiznit'],
    ['oulad-teima', 'أولاد تايمة', 'Oulad Teima'],
    ['tata', 'طاطا', 'Tata'],
  ]],
  ['08', 'درعة تافيلالت', 'Drâa-Tafilalet', [
    ['errachidia', 'الرشيدية', 'Errachidia'],
    ['ouarzazate', 'ورزازات', 'Ouarzazate'],
    ['zagora', 'زاكورة', 'Zagora'],
    ['tinghir', 'تنغير', 'Tinghir'],
    ['midelt', 'ميدلت', 'Midelt'],
    ['erfoud', 'أرفود', 'Erfoud'],
  ]],
  ['10', 'كلميم واد نون', 'Guelmim-Oued Noun', [
    ['guelmim', 'كلميم', 'Guelmim'],
    ['tan-tan', 'طانطان', 'Tan-Tan'],
    ['sidi-ifni', 'سيدي إفني', 'Sidi Ifni'],
    ['assa', 'أسا', 'Assa'],
  ]],
  ['11', 'العيون الساقية الحمراء', 'Laâyoune-Sakia El Hamra', [
    ['laayoune', 'العيون', 'Laâyoune'],
    ['boujdour', 'بوجدور', 'Boujdour'],
    ['smara', 'السمارة', 'Smara'],
    ['tarfaya', 'طرفاية', 'Tarfaya'],
  ]],
  ['12', 'الداخلة وادي الذهب', 'Dakhla-Oued Ed-Dahab', [
    ['dakhla', 'الداخلة', 'Dakhla'],
    ['aousserd', 'أوسرد', 'Aousserd'],
  ]],
];

// By wilaya number; each wilaya's capital carries its name.
const ALGERIA = [
  ['01', 'أدرار', 'Adrar', [['adrar', 'أدرار', 'Adrar']]],
  ['02', 'الشلف', 'Chlef', [['chlef', 'الشلف', 'Chlef'], ['tenes', 'تنس', 'Ténès']]],
  ['03', 'الأغواط', 'Laghouat', [['laghouat', 'الأغواط', 'Laghouat'], ['aflou', 'آفلو', 'Aflou']]],
  ['04', 'أم البواقي', 'Oum El Bouaghi', [['oum-el-bouaghi', 'أم البواقي', 'Oum El Bouaghi'], ['ain-beida', 'عين البيضاء', 'Aïn Beïda']]],
  ['05', 'باتنة', 'Batna', [['batna', 'باتنة', 'Batna'], ['barika', 'بريكة', 'Barika'], ['ain-touta', 'عين التوتة', 'Aïn Touta'], ['arris', 'أريس', 'Arris']]],
  ['06', 'بجاية', 'Béjaïa', [['bejaia', 'بجاية', 'Béjaïa'], ['akbou', 'أقبو', 'Akbou']]],
  ['07', 'بسكرة', 'Biskra', [['biskra', 'بسكرة', 'Biskra'], ['tolga', 'طولقة', 'Tolga']]],
  ['08', 'بشار', 'Béchar', [['bechar', 'بشار', 'Béchar']]],
  ['09', 'البليدة', 'Blida', [['blida', 'البليدة', 'Blida'], ['boufarik', 'بوفاريك', 'Boufarik'], ['larbaa', 'الأربعاء', 'Larbaâ']]],
  ['10', 'البويرة', 'Bouira', [['bouira', 'البويرة', 'Bouira'], ['lakhdaria', 'الأخضرية', 'Lakhdaria']]],
  ['11', 'تمنراست', 'Tamanrasset', [['tamanrasset', 'تمنراست', 'Tamanrasset']]],
  ['12', 'تبسة', 'Tébessa', [['tebessa', 'تبسة', 'Tébessa'], ['bir-el-ater', 'بئر العاتر', 'Bir El Ater']]],
  ['13', 'تلمسان', 'Tlemcen', [['tlemcen', 'تلمسان', 'Tlemcen'], ['maghnia', 'مغنية', 'Maghnia'], ['ghazaouet', 'الغزوات', 'Ghazaouet']]],
  ['14', 'تيارت', 'Tiaret', [['tiaret', 'تيارت', 'Tiaret']]],
  ['15', 'تيزي وزو', 'Tizi Ouzou', [['tizi-ouzou', 'تيزي وزو', 'Tizi Ouzou'], ['azazga', 'عزازقة', 'Azazga'], ['draa-ben-khedda', 'ذراع بن خدة', 'Draâ Ben Khedda']]],
  ['16', 'الجزائر', 'Algiers', [
    ['algiers', 'الجزائر', 'Algiers'],
    ['bab-ezzouar', 'باب الزوار', 'Bab Ezzouar'],
    ['dar-el-beida', 'الدار البيضاء', 'Dar El Beïda'],
    ['el-harrach', 'الحراش', 'El Harrach'],
    ['bir-mourad-rais', 'بئر مراد رايس', 'Bir Mourad Raïs'],
    ['cheraga', 'الشراقة', 'Chéraga'],
    ['zeralda', 'زرالدة', 'Zéralda'],
    ['rouiba', 'الرويبة', 'Rouïba'],
  ]],
  ['17', 'الجلفة', 'Djelfa', [['djelfa', 'الجلفة', 'Djelfa'], ['ain-oussera', 'عين وسارة', 'Aïn Oussera'], ['messaad', 'مسعد', 'Messaâd']]],
  ['18', 'جيجل', 'Jijel', [['jijel', 'جيجل', 'Jijel']]],
  ['19', 'سطيف', 'Sétif', [['setif', 'سطيف', 'Sétif'], ['el-eulma', 'العلمة', 'El Eulma'], ['ain-oulmene', 'عين ولمان', 'Aïn Oulmene'], ['ain-arnat', 'عين أرنات', 'Aïn Arnat']]],
  ['20', 'سعيدة', 'Saïda', [['saida', 'سعيدة', 'Saïda']]],
  ['21', 'سكيكدة', 'Skikda', [['skikda', 'سكيكدة', 'Skikda'], ['collo', 'القل', 'Collo']]],
  ['22', 'سيدي بلعباس', 'Sidi Bel Abbès', [['sidi-bel-abbes', 'سيدي بلعباس', 'Sidi Bel Abbès']]],
  ['23', 'عنابة', 'Annaba', [['annaba', 'عنابة', 'Annaba'], ['el-bouni', 'البوني', 'El Bouni'], ['el-hadjar', 'الحجار', 'El Hadjar']]],
  ['24', 'قالمة', 'Guelma', [['guelma', 'قالمة', 'Guelma']]],
  ['25', 'قسنطينة', 'Constantine', [['constantine', 'قسنطينة', 'Constantine'], ['el-khroub', 'الخروب', 'El Khroub'], ['ali-mendjeli', 'علي منجلي', 'Ali Mendjeli'], ['hamma-bouziane', 'حامة بوزيان', 'Hamma Bouziane']]],
  ['26', 'المدية', 'Médéa', [['medea', 'المدية', 'Médéa'], ['berrouaghia', 'البرواقية', 'Berrouaghia']]],
  ['27', 'مستغانم', 'Mostaganem', [['mostaganem', 'مستغانم', 'Mostaganem']]],
  ['28', 'المسيلة', "M'Sila", [['msila', 'المسيلة', "M'Sila"], ['bou-saada', 'بوسعادة', 'Bou Saâda']]],
  ['29', 'معسكر', 'Mascara', [['mascara', 'معسكر', 'Mascara']]],
  ['30', 'ورقلة', 'Ouargla', [['ouargla', 'ورقلة', 'Ouargla'], ['hassi-messaoud', 'حاسي مسعود', 'Hassi Messaoud']]],
  ['31', 'وهران', 'Oran', [['oran', 'وهران', 'Oran'], ['es-senia', 'السانية', 'Es Sénia'], ['bir-el-djir', 'بئر الجير', 'Bir El Djir'], ['arzew', 'أرزيو', 'Arzew'], ['ain-el-turk', 'عين الترك', 'Aïn El Turk']]],
  ['32', 'البيض', 'El Bayadh', [['el-bayadh', 'البيض', 'El Bayadh']]],
  ['33', 'إليزي', 'Illizi', [['illizi', 'إليزي', 'Illizi']]],
  ['34', 'برج بوعريريج', 'Bordj Bou Arréridj', [['bordj-bou-arreridj', 'برج بوعريريج', 'Bordj Bou Arréridj']]],
  ['35', 'بومرداس', 'Boumerdès', [['boumerdes', 'بومرداس', 'Boumerdès'], ['bordj-menaiel', 'برج منايل', 'Bordj Menaïel'], ['khemis-el-khechna', 'خميس الخشنة', 'Khemis El Khechna']]],
  ['36', 'الطارف', 'El Tarf', [['el-tarf', 'الطارف', 'El Tarf']]],
  ['37', 'تندوف', 'Tindouf', [['tindouf', 'تندوف', 'Tindouf']]],
  ['38', 'تيسمسيلت', 'Tissemsilt', [['tissemsilt', 'تيسمسيلت', 'Tissemsilt']]],
  ['39', 'الوادي', 'El Oued', [['el-oued', 'الوادي', 'El Oued']]],
  ['40', 'خنشلة', 'Khenchela', [['khenchela', 'خنشلة', 'Khenchela']]],
  ['41', 'سوق أهراس', 'Souk Ahras', [['souk-ahras', 'سوق أهراس', 'Souk Ahras']]],
  ['42', 'تيبازة', 'Tipaza', [['tipaza', 'تيبازة', 'Tipaza'], ['kolea', 'القليعة', 'Koléa'], ['cherchell', 'شرشال', 'Cherchell']]],
  ['43', 'ميلة', 'Mila', [['mila', 'ميلة', 'Mila'], ['chelghoum-laid', 'شلغوم العيد', 'Chelghoum Laïd']]],
  ['44', 'عين الدفلى', 'Aïn Defla', [['ain-defla', 'عين الدفلى', 'Aïn Defla'], ['khemis-miliana', 'خميس مليانة', 'Khemis Miliana']]],
  ['45', 'النعامة', 'Naâma', [['naama', 'النعامة', 'Naâma']]],
  ['46', 'عين تموشنت', 'Aïn Témouchent', [['ain-temouchent', 'عين تموشنت', 'Aïn Témouchent']]],
  ['47', 'غرداية', 'Ghardaïa', [['ghardaia', 'غرداية', 'Ghardaïa'], ['metlili', 'متليلي', 'Metlili']]],
  ['48', 'غليزان', 'Relizane', [['relizane', 'غليزان', 'Relizane']]],
  ['49', 'تيميمون', 'Timimoun', [['timimoun', 'تيميمون', 'Timimoun']]],
  ['50', 'برج باجي مختار', 'Bordj Badji Mokhtar', [['bordj-badji-mokhtar', 'برج باجي مختار', 'Bordj Badji Mokhtar']]],
  ['51', 'أولاد جلال', 'Ouled Djellal', [['ouled-djellal', 'أولاد جلال', 'Ouled Djellal']]],
  ['52', 'بني عباس', 'Béni Abbès', [['beni-abbes', 'بني عباس', 'Béni Abbès']]],
  ['53', 'عين صالح', 'In Salah', [['in-salah', 'عين صالح', 'In Salah']]],
  ['54', 'عين قزام', 'In Guezzam', [['in-guezzam', 'عين قزام', 'In Guezzam']]],
  ['55', 'تقرت', 'Touggourt', [['touggourt', 'تقرت', 'Touggourt']]],
  ['56', 'جانت', 'Djanet', [['djanet', 'جانت', 'Djanet']]],
  ['57', 'المغير', "El M'Ghair", [['el-mghair', 'المغير', "El M'Ghair"]]],
  ['58', 'المنيعة', 'El Meniaa', [['el-meniaa', 'المنيعة', 'El Meniaa']]],
];

const UAE = [
  ['du', 'دبي', 'Dubai', [
    ['dubai', 'دبي', 'Dubai'],
    ['jebel-ali', 'جبل علي', 'Jebel Ali'],
    ['hatta', 'حتا', 'Hatta'],
  ]],
  ['az', 'أبوظبي', 'Abu Dhabi', [
    ['abu-dhabi', 'أبوظبي', 'Abu Dhabi'],
    ['al-ain', 'العين', 'Al Ain'],
    ['mussafah', 'مصفح', 'Mussafah'],
    ['khalifa-city', 'مدينة خليفة', 'Khalifa City'],
    ['madinat-zayed', 'مدينة زايد', 'Madinat Zayed'],
    ['ruwais', 'الرويس', 'Ruwais'],
  ]],
  ['sh', 'الشارقة', 'Sharjah', [
    ['sharjah', 'الشارقة', 'Sharjah'],
    ['khor-fakkan', 'خورفكان', 'Khor Fakkan'],
    ['kalba', 'كلباء', 'Kalba'],
    ['dibba-al-hisn', 'دبا الحصن', 'Dibba Al Hisn'],
    ['al-dhaid', 'الذيد', 'Al Dhaid'],
  ]],
  ['aj', 'عجمان', 'Ajman', [
    ['ajman', 'عجمان', 'Ajman'],
    ['masfout', 'مصفوت', 'Masfout'],
  ]],
  ['uq', 'أم القيوين', 'Umm Al Quwain', [
    ['umm-al-quwain', 'أم القيوين', 'Umm Al Quwain'],
    ['falaj-al-mualla', 'فلج المعلا', 'Falaj Al Mualla'],
  ]],
  ['rk', 'رأس الخيمة', 'Ras Al Khaimah', [
    ['ras-al-khaimah', 'رأس الخيمة', 'Ras Al Khaimah'],
    ['al-jazirah-al-hamra', 'الجزيرة الحمراء', 'Al Jazirah Al Hamra'],
  ]],
  ['fu', 'الفجيرة', 'Fujairah', [
    ['fujairah', 'الفجيرة', 'Fujairah'],
    ['dibba-al-fujairah', 'دبا الفجيرة', 'Dibba Al Fujairah'],
    ['masafi', 'مسافي', 'Masafi'],
  ]],
];

const KUWAIT = [
  ['ku', 'محافظة العاصمة', 'Capital Governorate', [
    ['kuwait-city', 'مدينة الكويت', 'Kuwait City'],
    ['shuwaikh', 'الشويخ', 'Shuwaikh'],
    ['kaifan', 'كيفان', 'Kaifan'],
    ['dasma', 'الدسمة', 'Dasma'],
    ['sulaibikhat', 'الصليبخات', 'Sulaibikhat'],
  ]],
  ['ha', 'حولي', 'Hawalli', [
    ['hawalli', 'حولي', 'Hawalli'],
    ['salmiya', 'السالمية', 'Salmiya'],
    ['jabriya', 'الجابرية', 'Jabriya'],
    ['rumaithiya', 'الرميثية', 'Rumaithiya'],
    ['bayan', 'بيان', 'Bayan'],
    ['mishref', 'مشرف', 'Mishref'],
  ]],
  ['fa', 'الفروانية', 'Farwaniya', [
    ['farwaniya', 'الفروانية', 'Farwaniya'],
    ['khaitan', 'خيطان', 'Khaitan'],
    ['jleeb-al-shuyoukh', 'جليب الشيوخ', 'Jleeb Al Shuyoukh'],
    ['al-rai', 'الري', 'Al Rai'],
    ['ardiya', 'العارضية', 'Ardiya'],
  ]],
  ['ah', 'الأحمدي', 'Ahmadi', [
    ['ahmadi', 'الأحمدي', 'Ahmadi'],
    ['fahaheel', 'الفحيحيل', 'Fahaheel'],
    ['mangaf', 'المنقف', 'Mangaf'],
    ['fintas', 'الفنطاس', 'Fintas'],
    ['abu-halifa', 'أبو حليفة', 'Abu Halifa'],
    ['sabah-al-ahmad', 'مدينة صباح الأحمد', 'Sabah Al Ahmad City'],
  ]],
  ['ja', 'الجهراء', 'Jahra', [
    ['jahra', 'الجهراء', 'Jahra'],
    ['saad-al-abdullah', 'سعد العبدالله', 'Saad Al Abdullah'],
    ['sulaibiya', 'الصليبية', 'Sulaibiya'],
    ['abdali', 'العبدلي', 'Abdali'],
  ]],
  ['mu', 'مبارك الكبير', 'Mubarak Al-Kabeer', [
    ['mubarak-al-kabeer', 'مبارك الكبير', 'Mubarak Al-Kabeer'],
    ['sabah-al-salem', 'صباح السالم', 'Sabah Al Salem'],
    ['qurain', 'القرين', 'Qurain'],
    ['adan', 'العدان', 'Adan'],
    ['abu-fatira', 'أبو فطيرة', 'Abu Fatira'],
  ]],
];

const JORDAN = [
  ['am', 'عمّان', 'Amman', [
    ['amman', 'عمّان', 'Amman'],
    ['wadi-al-seer', 'وادي السير', 'Wadi Al Seer'],
    ['sahab', 'سحاب', 'Sahab'],
    ['naour', 'ناعور', 'Naour'],
    ['al-muwaqqar', 'الموقر', 'Al Muwaqqar'],
  ]],
  ['az', 'الزرقاء', 'Zarqa', [
    ['zarqa', 'الزرقاء', 'Zarqa'],
    ['russeifa', 'الرصيفة', 'Russeifa'],
    ['hashemiyeh', 'الهاشمية', 'Hashemiyeh'],
  ]],
  ['ir', 'إربد', 'Irbid', [
    ['irbid', 'إربد', 'Irbid'],
    ['ramtha', 'الرمثا', 'Ramtha'],
    ['al-husn', 'الحصن', 'Al Husn'],
  ]],
  ['ba', 'البلقاء', 'Balqa', [
    ['salt', 'السلط', 'Salt'],
    ['fuheis', 'الفحيص', 'Fuheis'],
    ['deir-alla', 'دير علا', 'Deir Alla'],
  ]],
  ['md', 'مادبا', 'Madaba', [
    ['madaba', 'مادبا', 'Madaba'],
    ['dhiban', 'ذيبان', 'Dhiban'],
  ]],
  ['ma', 'المفرق', 'Mafraq', [
    ['mafraq', 'المفرق', 'Mafraq'],
    ['ruwaished', 'الرويشد', 'Ruwaished'],
  ]],
  ['ja', 'جرش', 'Jerash', [['jerash', 'جرش', 'Jerash']]],
  ['aj', 'عجلون', 'Ajloun', [
    ['ajloun', 'عجلون', 'Ajloun'],
    ['kufranjah', 'كفرنجة', 'Kufranjah'],
  ]],
  ['ka', 'الكرك', 'Karak', [
    ['karak', 'الكرك', 'Karak'],
    ['mutah', 'مؤتة', 'Mutah'],
  ]],
  ['at', 'الطفيلة', 'Tafilah', [
    ['tafilah', 'الطفيلة', 'Tafilah'],
    ['busaira', 'بصيرا', 'Busaira'],
  ]],
  ['mn', 'معان', "Ma'an", [
    ['maan', 'معان', "Ma'an"],
    ['wadi-musa', 'وادي موسى', 'Wadi Musa'],
    ['shoubak', 'الشوبك', 'Shoubak'],
  ]],
  ['aq', 'العقبة', 'Aqaba', [['aqaba', 'العقبة', 'Aqaba']]],
];

const LIBYA = [
  ['tb', 'طرابلس', 'Tripoli', [
    ['tripoli', 'طرابلس', 'Tripoli'],
    ['tajoura', 'تاجوراء', 'Tajoura'],
  ]],
  ['ba', 'بنغازي', 'Benghazi', [['benghazi', 'بنغازي', 'Benghazi']]],
  ['mi', 'مصراتة', 'Misrata', [['misrata', 'مصراتة', 'Misrata']]],
  ['za', 'الزاوية', 'Zawiya', [['zawiya', 'الزاوية', 'Zawiya']]],
  ['ji', 'الجفارة', 'Jafara', [['al-aziziyah', 'العزيزية', 'Al Aziziyah']]],
  ['mb', 'المرقب', 'Murqub', [['al-khums', 'الخمس', 'Al Khums']]],
  ['nq', 'النقاط الخمس', 'Nuqat al Khams', [['zuwara', 'زوارة', 'Zuwara']]],
  ['jg', 'الجبل الغربي', 'Jabal al Gharbi', [
    ['gharyan', 'غريان', 'Gharyan'],
    ['yafran', 'يفرن', 'Yafran'],
  ]],
  ['nl', 'نالوت', 'Nalut', [['nalut', 'نالوت', 'Nalut']]],
  ['sr', 'سرت', 'Sirte', [['sirte', 'سرت', 'Sirte']]],
  ['ja', 'الجبل الأخضر', 'Jabal al Akhdar', [['al-bayda', 'البيضاء', 'Al Bayda']]],
  ['mj', 'المرج', 'Marj', [['al-marj', 'المرج', 'Al Marj']]],
  ['dr', 'درنة', 'Derna', [['derna', 'درنة', 'Derna']]],
  ['bu', 'البطنان', 'Butnan', [['tobruk', 'طبرق', 'Tobruk']]],
  ['wa', 'الواحات', 'Al Wahat', [
    ['ajdabiya', 'أجدابيا', 'Ajdabiya'],
    ['jalu', 'جالو', 'Jalu'],
    ['awjila', 'أوجلة', 'Awjila'],
  ]],
  ['kf', 'الكفرة', 'Kufra', [['kufra', 'الكفرة', 'Kufra']]],
  ['ju', 'الجفرة', 'Jufra', [
    ['hun', 'هون', 'Hun'],
    ['waddan', 'ودان', 'Waddan'],
  ]],
  ['sb', 'سبها', 'Sabha', [['sabha', 'سبها', 'Sabha']]],
  ['ws', 'وادي الشاطئ', 'Wadi al Shatii', [['brak', 'براك', 'Brak']]],
  ['wd', 'وادي الحياة', 'Wadi al Hayaa', [['ubari', 'أوباري', 'Ubari']]],
  ['mq', 'مرزق', 'Murzuq', [['murzuq', 'مرزق', 'Murzuq']]],
  ['gt', 'غات', 'Ghat', [['ghat', 'غات', 'Ghat']]],
];

const PALESTINE = [
  ['jem', 'القدس', 'Jerusalem', [
    ['jerusalem', 'القدس', 'Jerusalem'],
    ['al-eizariya', 'العيزرية', 'Al Eizariya'],
    ['abu-dis', 'أبو ديس', 'Abu Dis'],
    ['al-ram', 'الرام', 'Al Ram'],
  ]],
  ['rbh', 'رام الله والبيرة', 'Ramallah and Al-Bireh', [
    ['ramallah', 'رام الله', 'Ramallah'],
    ['al-bireh', 'البيرة', 'Al Bireh'],
  ]],
  ['hbn', 'الخليل', 'Hebron', [
    ['hebron', 'الخليل', 'Hebron'],
    ['halhul', 'حلحول', 'Halhul'],
    ['dura', 'دورا', 'Dura'],
    ['yatta', 'يطا', 'Yatta'],
  ]],
  ['nbs', 'نابلس', 'Nablus', [['nablus', 'نابلس', 'Nablus']]],
  ['bth', 'بيت لحم', 'Bethlehem', [
    ['bethlehem', 'بيت لحم', 'Bethlehem'],
    ['beit-jala', 'بيت جالا', 'Beit Jala'],
    ['beit-sahour', 'بيت ساحور', 'Beit Sahour'],
  ]],
  ['jen', 'جنين', 'Jenin', [['jenin', 'جنين', 'Jenin']]],
  ['tkm', 'طولكرم', 'Tulkarm', [['tulkarm', 'طولكرم', 'Tulkarm']]],
  ['qqa', 'قلقيلية', 'Qalqilya', [['qalqilya', 'قلقيلية', 'Qalqilya']]],
  ['slt', 'سلفيت', 'Salfit', [['salfit', 'سلفيت', 'Salfit']]],
  ['tbs', 'طوباس', 'Tubas', [['tubas', 'طوباس', 'Tubas']]],
  ['jrh', 'أريحا والأغوار', 'Jericho and Al-Aghwar', [['jericho', 'أريحا', 'Jericho']]],
  ['ngz', 'شمال غزة', 'North Gaza', [
    ['jabalia', 'جباليا', 'Jabalia'],
    ['beit-lahia', 'بيت لاهيا', 'Beit Lahia'],
    ['beit-hanoun', 'بيت حانون', 'Beit Hanoun'],
  ]],
  ['gza', 'غزة', 'Gaza', [['gaza', 'غزة', 'Gaza']]],
  ['deb', 'دير البلح', 'Deir al-Balah', [['deir-al-balah', 'دير البلح', 'Deir al-Balah']]],
  ['kys', 'خان يونس', 'Khan Yunis', [['khan-yunis', 'خان يونس', 'Khan Yunis']]],
  ['rfh', 'رفح', 'Rafah', [['rafah', 'رفح', 'Rafah']]],
];

// By ISO code, which follows the country's own numbering (north-east to south).
const TUNISIA = [
  ['11', 'تونس', 'Tunis', [
    ['tunis', 'تونس', 'Tunis'],
    ['la-marsa', 'المرسى', 'La Marsa'],
    ['carthage', 'قرطاج', 'Carthage'],
    ['le-bardo', 'باردو', 'Le Bardo'],
    ['la-goulette', 'حلق الوادي', 'La Goulette'],
  ]],
  ['12', 'أريانة', 'Ariana', [
    ['ariana', 'أريانة', 'Ariana'],
    ['la-soukra', 'سكرة', 'La Soukra'],
    ['raoued', 'رواد', 'Raoued'],
  ]],
  ['13', 'بن عروس', 'Ben Arous', [
    ['ben-arous', 'بن عروس', 'Ben Arous'],
    ['hammam-lif', 'حمام الأنف', 'Hammam Lif'],
    ['rades', 'رادس', 'Radès'],
    ['ezzahra', 'الزهراء', 'Ezzahra'],
    ['megrine', 'مقرين', 'Mégrine'],
  ]],
  ['14', 'منوبة', 'Manouba', [
    ['manouba', 'منوبة', 'Manouba'],
    ['douar-hicher', 'دوار هيشر', 'Douar Hicher'],
    ['oued-ellil', 'وادي الليل', 'Oued Ellil'],
  ]],
  ['21', 'نابل', 'Nabeul', [
    ['nabeul', 'نابل', 'Nabeul'],
    ['hammamet', 'الحمامات', 'Hammamet'],
    ['kelibia', 'قليبية', 'Kélibia'],
    ['korba', 'قربة', 'Korba'],
    ['menzel-temime', 'منزل تميم', 'Menzel Temime'],
  ]],
  ['22', 'زغوان', 'Zaghouan', [['zaghouan', 'زغوان', 'Zaghouan']]],
  ['23', 'بنزرت', 'Bizerte', [
    ['bizerte', 'بنزرت', 'Bizerte'],
    ['menzel-bourguiba', 'منزل بورقيبة', 'Menzel Bourguiba'],
    ['mateur', 'ماطر', 'Mateur'],
  ]],
  ['31', 'باجة', 'Béja', [['beja', 'باجة', 'Béja']]],
  ['32', 'جندوبة', 'Jendouba', [
    ['jendouba', 'جندوبة', 'Jendouba'],
    ['tabarka', 'طبرقة', 'Tabarka'],
  ]],
  ['33', 'الكاف', 'Le Kef', [['le-kef', 'الكاف', 'Le Kef']]],
  ['34', 'سليانة', 'Siliana', [['siliana', 'سليانة', 'Siliana']]],
  ['41', 'القيروان', 'Kairouan', [['kairouan', 'القيروان', 'Kairouan']]],
  ['42', 'القصرين', 'Kasserine', [['kasserine', 'القصرين', 'Kasserine']]],
  ['43', 'سيدي بوزيد', 'Sidi Bouzid', [['sidi-bouzid', 'سيدي بوزيد', 'Sidi Bouzid']]],
  ['51', 'سوسة', 'Sousse', [
    ['sousse', 'سوسة', 'Sousse'],
    ['msaken', 'مساكن', 'Msaken'],
    ['hammam-sousse', 'حمام سوسة', 'Hammam Sousse'],
    ['kalaa-kebira', 'القلعة الكبرى', 'Kalâa Kebira'],
    ['enfidha', 'النفيضة', 'Enfidha'],
  ]],
  ['52', 'المنستير', 'Monastir', [
    ['monastir', 'المنستير', 'Monastir'],
    ['moknine', 'المكنين', 'Moknine'],
    ['ksar-hellal', 'قصر هلال', 'Ksar Hellal'],
    ['jemmal', 'جمال', 'Jemmal'],
  ]],
  ['53', 'المهدية', 'Mahdia', [
    ['mahdia', 'المهدية', 'Mahdia'],
    ['el-jem', 'الجم', 'El Jem'],
    ['ksour-essef', 'قصور الساف', 'Ksour Essef'],
  ]],
  ['61', 'صفاقس', 'Sfax', [
    ['sfax', 'صفاقس', 'Sfax'],
    ['sakiet-ezzit', 'ساقية الزيت', 'Sakiet Ezzit'],
    ['sakiet-eddaier', 'ساقية الداير', 'Sakiet Eddaïer'],
  ]],
  ['71', 'قفصة', 'Gafsa', [
    ['gafsa', 'قفصة', 'Gafsa'],
    ['metlaoui', 'المتلوي', 'Métlaoui'],
    ['redeyef', 'الرديف', 'Redeyef'],
  ]],
  ['72', 'توزر', 'Tozeur', [
    ['tozeur', 'توزر', 'Tozeur'],
    ['nefta', 'نفطة', 'Nefta'],
  ]],
  ['73', 'قبلي', 'Kébili', [
    ['kebili', 'قبلي', 'Kébili'],
    ['douz', 'دوز', 'Douz'],
  ]],
  ['81', 'قابس', 'Gabès', [['gabes', 'قابس', 'Gabès']]],
  ['82', 'مدنين', 'Médenine', [
    ['medenine', 'مدنين', 'Médenine'],
    ['djerba-houmt-souk', 'جربة حومة السوق', 'Djerba Houmt Souk'],
    ['zarzis', 'جرجيس', 'Zarzis'],
    ['ben-gardane', 'بن قردان', 'Ben Gardane'],
  ]],
  ['83', 'تطاوين', 'Tataouine', [['tataouine', 'تطاوين', 'Tataouine']]],
];

const IRAQ = [
  ['bg', 'بغداد', 'Baghdad', [
    ['baghdad', 'بغداد', 'Baghdad'],
    ['kadhimiya', 'الكاظمية', 'Kadhimiya'],
    ['adhamiyah', 'الأعظمية', 'Adhamiyah'],
    ['sadr-city', 'مدينة الصدر', 'Sadr City'],
    ['abu-ghraib', 'أبو غريب', 'Abu Ghraib'],
    ['mahmudiyah', 'المحمودية', 'Mahmudiyah'],
  ]],
  ['ba', 'البصرة', 'Basra', [
    ['basra', 'البصرة', 'Basra'],
    ['zubair', 'الزبير', 'Zubair'],
    ['umm-qasr', 'أم قصر', 'Umm Qasr'],
    ['abu-al-khasib', 'أبو الخصيب', 'Abu Al Khasib'],
    ['qurna', 'القرنة', 'Al Qurna'],
  ]],
  ['ni', 'نينوى', 'Nineveh', [
    ['mosul', 'الموصل', 'Mosul'],
    ['tal-afar', 'تلعفر', 'Tal Afar'],
    ['sinjar', 'سنجار', 'Sinjar'],
  ]],
  ['ar', 'أربيل', 'Erbil', [
    ['erbil', 'أربيل', 'Erbil'],
    ['shaqlawa', 'شقلاوة', 'Shaqlawa'],
    ['soran', 'سوران', 'Soran'],
    ['koya', 'كويسنجق', 'Koya'],
  ]],
  ['su', 'السليمانية', 'Sulaymaniyah', [
    ['sulaymaniyah', 'السليمانية', 'Sulaymaniyah'],
    ['ranya', 'رانية', 'Ranya'],
    ['kalar', 'كلار', 'Kalar'],
  ]],
  ['da', 'دهوك', 'Duhok', [
    ['duhok', 'دهوك', 'Duhok'],
    ['zakho', 'زاخو', 'Zakho'],
    ['amedi', 'العمادية', 'Amedi'],
  ]],
  ['halabja', 'حلبجة', 'Halabja', [['halabja', 'حلبجة', 'Halabja']]],
  ['ki', 'كركوك', 'Kirkuk', [
    ['kirkuk', 'كركوك', 'Kirkuk'],
    ['hawija', 'الحويجة', 'Hawija'],
  ]],
  ['an', 'الأنبار', 'Anbar', [
    ['ramadi', 'الرمادي', 'Ramadi'],
    ['fallujah', 'الفلوجة', 'Fallujah'],
    ['hit', 'هيت', 'Hit'],
    ['haditha', 'حديثة', 'Haditha'],
    ['al-qaim', 'القائم', 'Al Qaim'],
  ]],
  ['bb', 'بابل', 'Babil', [
    ['hillah', 'الحلة', 'Hillah'],
    ['musayyib', 'المسيب', 'Musayyib'],
    ['iskandariya', 'الإسكندرية', 'Iskandariya'],
  ]],
  ['ka', 'كربلاء', 'Karbala', [
    ['karbala', 'كربلاء', 'Karbala'],
    ['ain-al-tamr', 'عين التمر', 'Ain Al Tamr'],
  ]],
  ['na', 'النجف', 'Najaf', [
    ['najaf', 'النجف', 'Najaf'],
    ['kufa', 'الكوفة', 'Kufa'],
  ]],
  ['qa', 'القادسية', 'Al-Qadisiyah', [['diwaniyah', 'الديوانية', 'Diwaniyah']]],
  ['wa', 'واسط', 'Wasit', [
    ['kut', 'الكوت', 'Kut'],
    ['suwaira', 'الصويرة', 'Suwaira'],
    ['aziziyah', 'العزيزية', 'Aziziyah'],
  ]],
  ['ma', 'ميسان', 'Maysan', [['amarah', 'العمارة', 'Amarah']]],
  ['dq', 'ذي قار', 'Dhi Qar', [
    ['nasiriyah', 'الناصرية', 'Nasiriyah'],
    ['shatra', 'الشطرة', 'Shatra'],
    ['suq-al-shuyukh', 'سوق الشيوخ', 'Suq Al Shuyukh'],
  ]],
  ['mu', 'المثنى', 'Muthanna', [
    ['samawah', 'السماوة', 'Samawah'],
    ['rumaitha', 'الرميثة', 'Rumaitha'],
  ]],
  ['di', 'ديالى', 'Diyala', [
    ['baqubah', 'بعقوبة', 'Baqubah'],
    ['khanaqin', 'خانقين', 'Khanaqin'],
    ['muqdadiyah', 'المقدادية', 'Muqdadiyah'],
    ['balad-ruz', 'بلدروز', 'Balad Ruz'],
  ]],
  ['sd', 'صلاح الدين', 'Salah Al-Din', [
    ['tikrit', 'تكريت', 'Tikrit'],
    ['samarra', 'سامراء', 'Samarra'],
    ['baiji', 'بيجي', 'Baiji'],
    ['balad', 'بلد', 'Balad'],
    ['tuz-khurmatu', 'طوز خورماتو', 'Tuz Khurmatu'],
  ]],
];

const QATAR = [
  ['da', 'الدوحة', 'Doha', [
    ['doha', 'الدوحة', 'Doha'],
    ['west-bay', 'الخليج الغربي', 'West Bay'],
    ['al-sadd', 'السد', 'Al Sadd'],
    ['al-dafna', 'الدفنة', 'Al Dafna'],
  ]],
  ['ra', 'الريان', 'Al Rayyan', [
    ['al-rayyan', 'الريان', 'Al Rayyan'],
    ['al-gharrafa', 'الغرافة', 'Al Gharrafa'],
    ['muaither', 'معيذر', 'Muaither'],
  ]],
  ['wa', 'الوكرة', 'Al Wakrah', [
    ['al-wakrah', 'الوكرة', 'Al Wakrah'],
    ['al-wukair', 'الوكير', 'Al Wukair'],
    ['mesaieed', 'مسيعيد', 'Mesaieed'],
  ]],
  ['za', 'الضعاين', 'Al Daayen', [
    ['lusail', 'لوسيل', 'Lusail'],
    ['simaisma', 'سميسمة', 'Simaisma'],
  ]],
  ['us', 'أم صلال', 'Umm Salal', [
    ['umm-salal-mohammed', 'أم صلال محمد', 'Umm Salal Mohammed'],
    ['umm-salal-ali', 'أم صلال علي', 'Umm Salal Ali'],
  ]],
  ['kh', 'الخور والذخيرة', 'Al Khor and Al Thakhira', [
    ['al-khor', 'الخور', 'Al Khor'],
    ['al-thakhira', 'الذخيرة', 'Al Thakhira'],
    ['ras-laffan', 'رأس لفان', 'Ras Laffan'],
  ]],
  ['ms', 'الشمال', 'Al Shamal', [
    ['madinat-al-shamal', 'مدينة الشمال', 'Madinat Al Shamal'],
    ['al-ruwais', 'الرويس', 'Al Ruwais'],
  ]],
  ['sh', 'الشحانية', 'Al Shahaniya', [
    ['al-shahaniya', 'الشحانية', 'Al Shahaniya'],
    ['dukhan', 'دخان', 'Dukhan'],
  ]],
];

const BAHRAIN = [
  ['13', 'محافظة العاصمة', 'Capital Governorate', [
    ['manama', 'المنامة', 'Manama'],
    ['juffair', 'الجفير', 'Juffair'],
    ['adliya', 'العدلية', 'Adliya'],
    ['seef', 'السيف', 'Seef'],
    ['gudaibiya', 'القضيبية', 'Gudaibiya'],
  ]],
  ['15', 'محافظة المحرق', 'Muharraq Governorate', [
    ['muharraq', 'المحرق', 'Muharraq'],
    ['hidd', 'الحد', 'Hidd'],
    ['arad', 'عراد', 'Arad'],
    ['busaiteen', 'البسيتين', 'Busaiteen'],
    ['galali', 'قلالي', 'Galali'],
  ]],
  ['17', 'المحافظة الشمالية', 'Northern Governorate', [
    ['hamad-town', 'مدينة حمد', 'Hamad Town'],
    ['budaiya', 'البديع', 'Budaiya'],
    ['diraz', 'الدراز', 'Diraz'],
    ['saar', 'سار', 'Saar'],
    ['janabiya', 'الجنبية', 'Janabiya'],
  ]],
  ['14', 'المحافظة الجنوبية', 'Southern Governorate', [
    ['riffa', 'الرفاع', 'Riffa'],
    ['awali', 'عوالي', 'Awali'],
    ['zallaq', 'الزلاق', 'Zallaq'],
    ['askar', 'عسكر', 'Askar'],
    ['jaw', 'جو', 'Jaw'],
  ]],
];

const OMAN = [
  ['ma', 'مسقط', 'Muscat', [
    ['muscat', 'مسقط', 'Muscat'],
    ['muttrah', 'مطرح', 'Muttrah'],
    ['bawshar', 'بوشر', 'Bawshar'],
    ['seeb', 'السيب', 'Seeb'],
    ['amerat', 'العامرات', 'Al Amerat'],
    ['qurayyat', 'قريات', 'Qurayyat'],
  ]],
  ['zu', 'ظفار', 'Dhofar', [
    ['salalah', 'صلالة', 'Salalah'],
    ['taqah', 'طاقة', 'Taqah'],
    ['mirbat', 'مرباط', 'Mirbat'],
    ['thumrait', 'ثمريت', 'Thumrait'],
  ]],
  ['bs', 'شمال الباطنة', 'North Al Batinah', [
    ['sohar', 'صحار', 'Sohar'],
    ['shinas', 'شناص', 'Shinas'],
    ['liwa', 'لوى', 'Liwa'],
    ['saham', 'صحم', 'Saham'],
    ['al-khaburah', 'الخابورة', 'Al Khaburah'],
    ['suwaiq', 'السويق', 'Suwaiq'],
  ]],
  ['bj', 'جنوب الباطنة', 'South Al Batinah', [
    ['rustaq', 'الرستاق', 'Rustaq'],
    ['barka', 'بركاء', 'Barka'],
    ['al-musannah', 'المصنعة', 'Al Musannah'],
    ['nakhal', 'نخل', 'Nakhal'],
  ]],
  ['da', 'الداخلية', 'Ad Dakhiliyah', [
    ['nizwa', 'نزوى', 'Nizwa'],
    ['bahla', 'بهلاء', 'Bahla'],
    ['samail', 'سمائل', 'Samail'],
    ['izki', 'إزكي', 'Izki'],
    ['adam', 'أدم', 'Adam'],
  ]],
  ['ss', 'شمال الشرقية', 'North Al Sharqiyah', [
    ['ibra', 'إبراء', 'Ibra'],
    ['al-mudhaibi', 'المضيبي', 'Al Mudhaibi'],
    ['bidiyah', 'بدية', 'Bidiyah'],
  ]],
  ['sj', 'جنوب الشرقية', 'South Al Sharqiyah', [
    ['sur', 'صور', 'Sur'],
    ['jalan-bani-bu-ali', 'جعلان بني بو علي', 'Jalan Bani Bu Ali'],
    ['masirah', 'مصيرة', 'Masirah'],
  ]],
  ['za', 'الظاهرة', 'Al Dhahirah', [
    ['ibri', 'عبري', 'Ibri'],
    ['yanqul', 'ينقل', 'Yanqul'],
    ['dhank', 'ضنك', 'Dhank'],
  ]],
  ['bu', 'البريمي', 'Al Buraimi', [
    ['al-buraimi', 'البريمي', 'Al Buraimi'],
    ['mahdah', 'محضة', 'Mahdah'],
  ]],
  ['wu', 'الوسطى', 'Al Wusta', [
    ['haima', 'هيماء', 'Haima'],
    ['duqm', 'الدقم', 'Duqm'],
  ]],
  ['mu', 'مسندم', 'Musandam', [
    ['khasab', 'خصب', 'Khasab'],
    ['bukha', 'بخا', 'Bukha'],
    ['dibba', 'دبا', 'Dibba'],
  ]],
];

const COUNTRIES = [
  ['MA', MOROCCO],
  ['DZ', ALGERIA],
  ['AE', UAE],
  ['KW', KUWAIT],
  ['JO', JORDAN],
  ['LY', LIBYA],
  ['PS', PALESTINE],
  ['TN', TUNISIA],
  ['IQ', IRAQ],
  ['QA', QATAR],
  ['BH', BAHRAIN],
  ['OM', OMAN],
];

/** The rows of geo_regions these countries add, parents first, in display order. */
function rows() {
  const out = [];
  for (const [country, list] of COUNTRIES) {
    list.forEach(([suffix, ar, en, cities], i) => {
      const code = `${country.toLowerCase()}-${suffix}`;
      out.push({ code, country, level: 'governorate', parentCode: null, nameAr: ar, nameEn: en, sortOrder: i });
      cities.forEach(([citySlug, cityAr, cityEn], j) => {
        out.push({ code: `${code}.${citySlug}`, country, level: 'city', parentCode: code, nameAr: cityAr, nameEn: cityEn, sortOrder: j });
      });
    });
  }
  return out;
}

const countries = () => COUNTRIES.map(([country]) => country);

module.exports = { rows, countries };
