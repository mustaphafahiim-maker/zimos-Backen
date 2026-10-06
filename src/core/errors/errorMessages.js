'use strict';

/**
 * Error messages in the reader's language (frontend request U-02/U-03): the
 * dashboard and the storefront map the codes they know to their own wording;
 * a code they do not map reaches the shopper as `error.message`, which was
 * English only. This middleware rewrites that message to Arabic or French
 * when the request asks for it, for the codes a shopper or a signing-in
 * merchant meets. `code` and `details` are never changed (clients key on
 * them); an unknown code keeps its English message.
 *
 * Language: X-Store-Locale (the storefront's header), else the first
 * Accept-Language tag; anything but ar/fr leaves the answer as it is.
 */

const MESSAGES = {
  VALIDATION_ERROR: { ar: 'بعض البيانات غير صحيحة. راجعها وحاول مرة أخرى.', fr: 'Certaines informations ne sont pas valides. Vérifiez-les et réessayez.' },
  INVALID_JSON: { ar: 'تعذّر قراءة الطلب.', fr: 'La requête est illisible.' },
  NOT_FOUND: { ar: 'غير موجود.', fr: 'Introuvable.' },
  ROUTE_NOT_FOUND: { ar: 'غير موجود.', fr: 'Introuvable.' },
  FORBIDDEN: { ar: 'ليس لديك صلاحية لهذا الإجراء.', fr: "Vous n'avez pas l'autorisation pour cette action." },
  UNAUTHENTICATED: { ar: 'سجّل الدخول للمتابعة.', fr: 'Connectez-vous pour continuer.' },
  INVALID_CREDENTIALS: { ar: 'البريد أو كلمة المرور غير صحيحة.', fr: 'E-mail ou mot de passe incorrect.' },
  INVALID_PASSWORD: { ar: 'كلمة المرور غير صحيحة.', fr: 'Mot de passe incorrect.' },
  INVALID_TOKEN: { ar: 'انتهت الجلسة. سجّل الدخول مرة أخرى.', fr: 'Session expirée. Reconnectez-vous.' },
  INVALID_REFRESH_TOKEN: { ar: 'انتهت الجلسة. سجّل الدخول مرة أخرى.', fr: 'Session expirée. Reconnectez-vous.' },
  REFRESH_TOKEN_EXPIRED: { ar: 'انتهت الجلسة. سجّل الدخول مرة أخرى.', fr: 'Session expirée. Reconnectez-vous.' },
  INVALID_TWO_FACTOR_CODE: { ar: 'رمز التحقق غير صحيح.', fr: 'Code de vérification incorrect.' },
  INVALID_CODE: { ar: 'الرمز غير صحيح أو منتهي.', fr: 'Code incorrect ou expiré.' },
  OTP_REQUIRED: { ar: 'أدخل رمز التحقق المرسل إليك.', fr: 'Saisissez le code de vérification envoyé.' },
  OTP_RATE_LIMITED: { ar: 'طلبات كثيرة للرمز. حاول بعد قليل.', fr: 'Trop de demandes de code. Réessayez plus tard.' },
  OTP_RESEND_TOO_SOON: { ar: 'انتظر قليلًا قبل طلب رمز جديد.', fr: 'Patientez avant de demander un nouveau code.' },
  TOO_MANY_ATTEMPTS: { ar: 'محاولات كثيرة. حاول بعد قليل.', fr: 'Trop de tentatives. Réessayez plus tard.' },
  RATE_LIMITED: { ar: 'طلبات كثيرة. حاول بعد قليل.', fr: 'Trop de requêtes. Réessayez plus tard.' },
  PHONE_NOT_VERIFIED: { ar: 'أكّد رقم الهاتف أولًا.', fr: "Vérifiez d'abord le numéro de téléphone." },
  INVALID_PHONE: { ar: 'أدخل رقم موبايل صحيح.', fr: 'Saisissez un numéro de mobile valide.' },
  INVALID_RESET_TOKEN: { ar: 'رابط تغيير كلمة المرور غير صالح أو منتهي.', fr: 'Lien de réinitialisation invalide ou expiré.' },
  INVALID_VERIFICATION_TOKEN: { ar: 'رابط التأكيد غير صالح أو منتهي.', fr: 'Lien de vérification invalide ou expiré.' },
  VERIFICATION_TOKEN_INVALID: { ar: 'رابط التأكيد غير صالح أو منتهي.', fr: 'Lien de vérification invalide ou expiré.' },
  TERMS_REQUIRED: { ar: 'وافق على الشروط للمتابعة.', fr: 'Acceptez les conditions pour continuer.' },
  SIGNUP_UNAVAILABLE: { ar: 'التسجيل غير متاح حاليًا.', fr: "L'inscription n'est pas disponible pour le moment." },
  STORE_UNAVAILABLE: { ar: 'المتجر غير متاح حاليًا.', fr: "La boutique n'est pas disponible pour le moment." },
  CART_NOT_FOUND: { ar: 'انتهت صلاحية السلة. أضف المنتجات مرة أخرى.', fr: 'Votre panier a expiré. Ajoutez à nouveau les produits.' },
  CART_TOKEN_REQUIRED: { ar: 'السلة فارغة.', fr: 'Le panier est vide.' },
  CART_TOKEN_OR_ITEM_REQUIRED: { ar: 'السلة فارغة.', fr: 'Le panier est vide.' },
  INSUFFICIENT_STOCK: { ar: 'الكمية المطلوبة غير متوفرة حاليًا.', fr: "La quantité demandée n'est plus disponible." },
  PRODUCT_NOT_FOUND: { ar: 'هذا المنتج لم يعد متاحًا.', fr: "Ce produit n'est plus disponible." },
  PAYMENT_METHOD_UNAVAILABLE: { ar: 'طريقة الدفع هذه غير متاحة. اختر طريقة أخرى.', fr: "Ce moyen de paiement n'est pas disponible. Choisissez-en un autre." },
  SHIPPING_PLACE_UNAVAILABLE: { ar: 'المتجر لا يوصّل لهذه المنطقة. اختر منطقة أخرى.', fr: 'La boutique ne livre pas cette zone. Choisissez-en une autre.' },
  INVALID_DISCOUNT_CODE: { ar: 'كود الخصم غير صحيح.', fr: 'Code promo invalide.' },
  DISCOUNT_EXPIRED: { ar: 'كود الخصم منتهي.', fr: 'Ce code promo a expiré.' },
  DISCOUNT_NOT_STARTED: { ar: 'كود الخصم لم يبدأ بعد.', fr: "Ce code promo n'est pas encore actif." },
  DISCOUNT_NOT_APPLICABLE: { ar: 'كود الخصم لا ينطبق على هذه المنتجات.', fr: "Ce code promo ne s'applique pas à ces produits." },
  DISCOUNT_MINIMUM_NOT_MET: { ar: 'الطلب أقل من الحد الأدنى لكود الخصم.', fr: "Le montant minimum pour ce code promo n'est pas atteint." },
  DISCOUNT_USAGE_LIMIT_REACHED: { ar: 'كود الخصم استُخدم بالكامل.', fr: "Ce code promo n'est plus disponible." },
  DISCOUNT_PER_CUSTOMER_LIMIT_REACHED: { ar: 'استخدمت كود الخصم هذا من قبل.', fr: 'Vous avez déjà utilisé ce code promo.' },
  MIN_ORDER_NOT_MET: { ar: 'الطلب أقل من الحد الأدنى للمتجر.', fr: "Le montant minimum de commande n'est pas atteint." },
  ORDER_BUMP_INVALID: { ar: 'هذا العرض لم يعد متاحًا.', fr: "Cette offre n'est plus disponible." },
  ORDER_BUMP_UNAVAILABLE: { ar: 'هذا العرض لم يعد متاحًا.', fr: "Cette offre n'est plus disponible." },
  UPSELL_CLOSED: { ar: 'انتهى وقت هذا العرض.', fr: 'Cette offre a expiré.' },
  UPSELL_INVALID: { ar: 'هذا العرض لم يعد متاحًا.', fr: "Cette offre n'est plus disponible." },
  FUNNEL_OFFER_UNAVAILABLE: { ar: 'هذا العرض لم يعد متاحًا.', fr: "Cette offre n'est plus disponible." },
  ORDER_REJECTED: { ar: 'تعذّر إتمام الطلب. تواصل مع المتجر.', fr: 'La commande ne peut pas être passée. Contactez la boutique.' },
  DEPOSIT_REQUIRED: { ar: 'هذا الطلب يحتاج دفع عربون أولًا.', fr: 'Cette commande nécessite un acompte.' },
  ORDER_PAYMENT_EXPIRED: { ar: 'انتهت مهلة الدفع لهذا الطلب.', fr: 'Le délai de paiement de cette commande a expiré.' },
  ORDER_ALREADY_PAID: { ar: 'تم دفع هذا الطلب بالفعل.', fr: 'Cette commande est déjà payée.' },
  VISITOR_ID_REQUIRED: { ar: 'أعد تحميل الصفحة وحاول مرة أخرى.', fr: 'Rechargez la page et réessayez.' },
  UNSUPPORTED_MEDIA_TYPE: { ar: 'يُقبل فقط صور JPEG أو PNG أو WebP.', fr: 'Seules les photos JPEG, PNG ou WebP sont acceptées.' },
  FILE_TOO_LARGE: { ar: 'الملف كبير جدًا.', fr: 'Le fichier est trop volumineux.' },
  NO_FILE: { ar: 'اختر ملفًا أولًا.', fr: "Choisissez d'abord un fichier." },
  TOO_MANY_PENDING_UPLOADS: { ar: 'صور كثيرة بانتظار الطلب. أكمل الطلب أو حاول لاحقًا.', fr: 'Trop de photos en attente. Finalisez la commande ou réessayez plus tard.' },
  IDEMPOTENCY_KEY_IN_PROGRESS: { ar: 'طلبك قيد التنفيذ، انتظر لحظة.', fr: 'Votre demande est en cours, patientez.' },
  INTERNAL_SERVER_ERROR: { ar: 'حدث خطأ غير متوقع. حاول مرة أخرى.', fr: "Une erreur inattendue s'est produite. Réessayez." },
};

const SUPPORTED = ['ar', 'fr'];

function languageOf(req) {
  const store = String(req.headers['x-store-locale'] || '').trim().toLowerCase().split(/[-_]/)[0];
  if (store) return store;
  const first = String(req.headers['accept-language'] || '').split(',')[0].trim().toLowerCase().split(/[-_;]/)[0];
  return first || null;
}

/** Express middleware: wraps res.json so an error body's message is in the reader's language. */
function translateErrors(req, res, next) {
  const lang = languageOf(req);
  if (!SUPPORTED.includes(lang)) return next();
  const json = res.json.bind(res);
  res.json = (body) => {
    const error = body && body.error;
    const text = error && typeof error.code === 'string' && MESSAGES[error.code] && MESSAGES[error.code][lang];
    // The English original stays beside it: some codes (VALIDATION_ERROR) carry a specific English message.
    return json(text && text !== error.message ? { ...body, error: { ...error, message: text, messageEn: error.message } } : body);
  };
  return next();
}

module.exports = { translateErrors, MESSAGES, languageOf };
