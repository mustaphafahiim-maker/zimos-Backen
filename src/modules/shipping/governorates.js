'use strict';

/**
 * Egypt's 27 governorates, the unit merchants price shipping by.
 *
 * `code` is the stable key stored in workspaces.settings.shipping_governorate_rates.
 * It is the same code the storefront's form stores (storefront lib/egypt.ts),
 * and the names match that list letter for letter.
 *
 * An order does not carry the code: shippingAddress.province holds what the
 * storefront sends, "<ar> (<en>)" — e.g. "القاهرة (Cairo)" — and a staff
 * order holds whatever the merchant typed. governorateCode reads either back.
 * Zone matching (shippingPricing.matchesZone) keeps comparing region strings
 * exactly, as it always has; only the governorate rates use this.
 */
const GOVERNORATES = Object.freeze([
  { code: 'cairo', ar: 'القاهرة', en: 'Cairo' },
  { code: 'giza', ar: 'الجيزة', en: 'Giza' },
  { code: 'alexandria', ar: 'الإسكندرية', en: 'Alexandria' },
  { code: 'qalyubia', ar: 'القليوبية', en: 'Qalyubia' },
  { code: 'sharqia', ar: 'الشرقية', en: 'Sharqia' },
  { code: 'dakahlia', ar: 'الدقهلية', en: 'Dakahlia' },
  { code: 'gharbia', ar: 'الغربية', en: 'Gharbia' },
  { code: 'monufia', ar: 'المنوفية', en: 'Monufia' },
  { code: 'beheira', ar: 'البحيرة', en: 'Beheira' },
  { code: 'kafr-el-sheikh', ar: 'كفر الشيخ', en: 'Kafr El Sheikh' },
  { code: 'damietta', ar: 'دمياط', en: 'Damietta' },
  { code: 'port-said', ar: 'بورسعيد', en: 'Port Said' },
  { code: 'ismailia', ar: 'الإسماعيلية', en: 'Ismailia' },
  { code: 'suez', ar: 'السويس', en: 'Suez' },
  { code: 'faiyum', ar: 'الفيوم', en: 'Faiyum' },
  { code: 'beni-suef', ar: 'بني سويف', en: 'Beni Suef' },
  { code: 'minya', ar: 'المنيا', en: 'Minya' },
  { code: 'asyut', ar: 'أسيوط', en: 'Asyut' },
  { code: 'sohag', ar: 'سوهاج', en: 'Sohag' },
  { code: 'qena', ar: 'قنا', en: 'Qena' },
  { code: 'luxor', ar: 'الأقصر', en: 'Luxor' },
  { code: 'aswan', ar: 'أسوان', en: 'Aswan' },
  { code: 'red-sea', ar: 'البحر الأحمر', en: 'Red Sea' },
  { code: 'new-valley', ar: 'الوادي الجديد', en: 'New Valley' },
  { code: 'matrouh', ar: 'مطروح', en: 'Matrouh' },
  { code: 'north-sinai', ar: 'شمال سيناء', en: 'North Sinai' },
  { code: 'south-sinai', ar: 'جنوب سيناء', en: 'South Sinai' },
]);

const CODES = Object.freeze(GOVERNORATES.map((g) => g.code));

const fold = (value) => String(value).trim().replace(/\s+/g, ' ').toLowerCase();

// Every spelling we accept, folded, to its code: the code itself, the Arabic
// name, the English name and the storefront's "<ar> (<en>)".
const BY_SPELLING = new Map();
for (const g of GOVERNORATES) {
  for (const spelling of [g.code, g.ar, g.en, `${g.ar} (${g.en})`]) BY_SPELLING.set(fold(spelling), g.code);
}

/**
 * The governorate code for a province as an order or a quote carries it, or
 * null when it names none of the 27 (a typo, another country's region).
 */
function governorateCode(province) {
  if (province === null || province === undefined || province === '') return null;
  return BY_SPELLING.get(fold(province)) || null;
}

function isGovernorateCode(code) {
  return CODES.includes(code);
}

module.exports = { GOVERNORATES, GOVERNORATE_CODES: CODES, governorateCode, isGovernorateCode };
