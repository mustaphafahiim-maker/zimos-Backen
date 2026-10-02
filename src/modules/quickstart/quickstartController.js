'use strict';

const asyncHandler = require('express-async-handler');
const { AppError } = require('../../core/errors/AppError');
const service = require('./quickstartService');
const { formatMoney } = require('./quickstartAdapter');
const authService = require('../auth/authService');
const { isVerified } = require('../auth/signupPolicy');
const { maskEmail } = require('../otp/verificationCodeService');

function basePath(req) {
  return req.originalUrl.split('?')[0];
}
function tokenOf(req) {
  // `formToken`: the form's hidden token, kept by confirmBeforePublish before
  // `validate` drops it from the body, so a re-shown form still signs in.
  return (req.body && req.body.token) || req.query.token || req.formToken || '';
}

// --- merchant (authenticated) -------------------------------------------

/**
 * The form publishes, so an account whose email isn't confirmed yet
 * (core/middleware/confirmedAccount) is asked for its code on the form
 * itself, with what it typed kept: "Send me a code" (intent=send_code, under
 * the codes' own limits) re-shows the form, and a code sent with the form
 * confirms the account and publishes in the same submit. Runs before
 * `validate`, which would drop the token and refuse the two extra fields.
 */
const confirmBeforePublish = asyncHandler(async (req, res, next) => {
  const { verificationCode, intent, ...fields } = req.body || {};
  const token = tokenOf(req);
  req.formToken = token;
  req.body = fields;
  if (isVerified(req.user)) return next();

  const show = (status, { error = null, notice = null } = {}) => {
    const { token: _token, ...existing } = fields;
    return res.status(status).render('merchant-form', {
      title: 'Add a product',
      actionUrl: basePath(req),
      token,
      existing,
      error,
      notice,
      confirm: { email: maskEmail(req.user.email) },
    });
  };
  const shown = (err) => {
    if (err instanceof AppError && err.statusCode !== 500) return show(err.statusCode, { error: err.message });
    throw err;
  };

  if (intent === 'send_code') {
    try {
      const sent = await authService.sendAccountCode(req.user, { locale: 'en' }, req);
      return show(200, { notice: `We sent a 6-digit code to ${sent.target}. It is valid for 10 minutes.` });
    } catch (err) {
      return shown(err);
    }
  }
  const code = String(verificationCode || '').trim();
  if (code) {
    if (!/^\d{6}$/.test(code)) return show(422, { error: 'The code is 6 digits.' });
    try {
      await authService.confirmAccountCode(req.user, code, req);
    } catch (err) {
      return shown(err);
    }
    return next();
  }
  return show(403, { error: 'Confirm your email address to publish. Send yourself a code, then enter it below.' });
});

const showForm = asyncHandler(async (req, res) => {
  const wid = req.tenant.workspaceId;
  const wantAddForm = req.query.add === '1' || !(await service.hasAnyProduct(wid));

  if (wantAddForm) {
    return res.render('merchant-form', {
      title: 'Add a product',
      actionUrl: basePath(req),
      token: tokenOf(req),
      existing: {},
      error: null,
    });
  }

  const { workspace, products } = await service.getMerchantStore(wid);
  res.render('merchant-store', {
    title: `${workspace.name} — my store`,
    base: basePath(req),
    token: tokenOf(req),
    workspace,
    products,
    publicUrl: `/shop/${wid}`,
    notice: req.query.saved ? 'Saved.' : null,
    error: null,
  });
});

const submitForm = asyncHandler(async (req, res) => {
  try {
    await service.addProduct(req.tenant.workspaceId, req.body, req);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) {
      return res.status(err.statusCode).render('merchant-form', {
        title: 'Add a product',
        actionUrl: basePath(req),
        token: tokenOf(req),
        existing: req.body,
        error: err.message,
      });
    }
    throw err;
  }
  res.render('merchant-done', {
    title: 'Product published',
    publicUrl: `/shop/${req.tenant.workspaceId}`,
    manageUrl: basePath(req) + (tokenOf(req) ? `?token=${tokenOf(req)}` : ''),
  });
});

// JSON branding + theme update.
const patchBranding = asyncHandler(async (req, res) => {
  const ws = await service.updateBranding(req.tenant.workspaceId, req.body, req);
  res.json({
    workspace: {
      id: ws.id,
      name: ws.name,
      logoUrl: ws.logoUrl,
      tagline: ws.tagline,
      themeSettings: ws.themeSettings || {},
    },
  });
});

const submitBranding = asyncHandler(async (req, res) => {
  try {
    await service.updateBranding(req.tenant.workspaceId, req.body, req);
  } catch (err) {
    if (err instanceof AppError && err.statusCode < 500) {
      const { workspace, products } = await service.getMerchantStore(req.tenant.workspaceId);
      return res.status(err.statusCode).render('merchant-store', {
        title: `${workspace.name} — my store`,
        base: basePath(req).replace(/\/branding$/, ''),
        token: tokenOf(req),
        workspace,
        products,
        publicUrl: `/shop/${req.tenant.workspaceId}`,
        notice: null,
        error: err.message,
      });
    }
    throw err;
  }
  const back = basePath(req).replace(/\/branding$/, '');
  const t = tokenOf(req);
  res.redirect(303, `${back}?saved=1${t ? `&token=${t}` : ''}`);
});

// --- public /shop viewer ----------------------------------------------

// The shopper may have arrived by store slug or by workspace UUID. Every
// lookup uses the workspace resolvePublicWorkspace settled on, while links
// keep the ref they actually used — see quickstartService.storeHomeLocals.
const renderStoreHome = asyncHandler(async (req, res) => {
  res.render('store-home', await service.storeHomeLocals(req.tenant.workspaceId, req.params.workspaceId));
});

const renderProductDetail = asyncHandler(async (req, res) => {
  res.render(
    'store-product',
    await service.productDetailLocals(req.tenant.workspaceId, req.params.productId, req.params.workspaceId)
  );
});

const renderCheckout = asyncHandler(async (req, res) => {
  const locals = await service.checkoutLocals(req.tenant.workspaceId, req.query.productId, req.params.workspaceId);
  res.render('checkout', { title: `Checkout — ${locals.product.name}`, ...locals, form: {}, error: null });
});

const submitCheckout = asyncHandler(async (req, res) => {
  try {
    const order = await service.placeSimpleOrder(req.tenant.workspaceId, req.body, req);
    return res.redirect(303, `/shop/${req.params.workspaceId}/thanks/${order.id}`);
  } catch (err) {
    const status = err instanceof AppError && err.statusCode < 500 ? err.statusCode : 400;
    let locals;
    try {
      locals = await service.checkoutLocals(req.tenant.workspaceId, req.body.productId, req.params.workspaceId);
    } catch (e2) {
      locals = { product: { name: 'your order', priceLabel: '' }, actionUrl: `/shop/${req.params.workspaceId}/checkout` };
    }
    return res.status(status).render('checkout', {
      title: `Checkout — ${locals.product.name}`,
      ...locals,
      form: req.body,
      error: err.message || 'Could not place the order',
    });
  }
});

const renderThankYou = asyncHandler(async (req, res) => {
  const { order, storeName } = await service.getOrderForThankYou(req.tenant.workspaceId, req.params.orderId);
  res.render('thankyou', {
    title: 'Thank you',
    order,
    storeName,
    totalLabel: formatMoney(order.totalAmount, order.currency),
    homeUrl: `/shop/${req.params.workspaceId}`,
  });
});

module.exports = {
  showForm,
  confirmBeforePublish,
  submitForm,
  submitBranding,
  patchBranding,
  renderStoreHome,
  renderProductDetail,
  renderCheckout,
  submitCheckout,
  renderThankYou,
};
