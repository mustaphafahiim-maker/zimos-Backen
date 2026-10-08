'use strict';

const crypto = require('crypto');
const logger = require('../../../core/utils/logger');
const { AppError } = require('../../../core/errors/AppError');
const { getProvider } = require('./index');

/**
 * Back-in-stock by push (item 392, modules/stockAlerts): on a sold-out
 * product the store's "Notify me" may use the browser instead of an email or
 * phone, when the store's app is on (its service worker shows the push) and
 * the server has a push provider — the same condition as the order updates
 * (`GET /store/:ws/push-config`). One message, once, about the stock the
 * shopper asked for; the subscription is dropped after it (§21: no campaigns).
 */

const storeAppOn = (workspace) => Boolean(workspace && workspace.settings && workspace.settings.store_app && workspace.settings.store_app.enabled === true);

/** For the subscribe route: { target, pushToken } to store, or 409/422. */
function prepare(workspace, token) {
  const provider = getProvider();
  if (!provider || !storeAppOn(workspace)) throw new AppError('PUSH_UNAVAILABLE', 'This store does not send notifications', 409);
  if (provider.checkToken) provider.checkToken('web', token);
  return { target: crypto.createHash('sha256').update(String(token)).digest('hex'), pushToken: token };
}

const TEXT = {
  ar: ['رجع متاح!', '{name} رجع متاح في {store}. اطلبه قبل ما يخلص.'],
  en: ['Back in stock', '{name} is back in stock at {store}. Order it before it sells out.'],
};

/** Sends the alert's one push. Resolves 'sent' | 'gone' | 'failed' | 'unavailable'; never throws. */
async function send(alert, { workspace, lang, productName, url }) {
  const provider = getProvider();
  if (!provider || !alert.pushToken || !storeAppOn(workspace)) return 'unavailable';
  const [title, body] = TEXT[lang === 'en' ? 'en' : 'ar'];
  try {
    await provider.send(
      { id: alert.id, platform: 'web', token: alert.pushToken },
      { workspaceId: workspace.id, type: 'shopper.back_in_stock', title, body: body.replace('{name}', productName).replace('{store}', workspace.name || ''), link: url }
    );
    return 'sent';
  } catch (err) {
    if (err && err.gone) return 'gone';
    logger.warn('Back-in-stock push failed', { alertId: alert.id, message: err.message });
    return 'failed';
  }
}

module.exports = { prepare, send };
