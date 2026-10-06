'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const db = require('../../db/models');
const gateways = require('./gateways');
const gatewayRuntime = require('./gatewayRuntime');
const sandbox = require('./gateways/sandbox');

/**
 * The sandbox gateway's "hosted payment page" (gateways/sandbox.js). Public,
 * like a real gateway's page: the signed link is the only credential. It has
 * no script — two plain links — so it works under the API's strict CSP.
 *
 * Mounted at /api/v1/sandbox-pay only when the sandbox gateway is registered.
 */
const router = Router();

// "Save a card" with no payment (sandboxSetupRoutes.js).
router.use('/setup', require('./sandboxSetupRoutes'));

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;background:#f4f4f0;margin:0;padding:48px 16px;color:#1c1c1c">
<main style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e3e3dc;border-radius:16px;padding:28px;text-align:center">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a6d1c">Sandbox — no money moves</p>
${body}</main></body></html>`;
}

async function load(req) {
  const providerOrderId = String(req.params.providerOrderId || '');
  const payment = await db.Payment.findOne({ where: { providerCode: sandbox.code, providerOrderId } });
  if (!payment || !gateways.isGateway(sandbox.code)) return null;
  const order = await db.Order.findByPk(payment.orderId, { attributes: ['id', 'workspaceId', 'orderNumber'] });
  if (!order) return null;
  const ctx = await gatewayRuntime.contextFor(order.workspaceId, sandbox.code);
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (!sandbox.safeEqualHex(sandbox.signPage(ctx.credentials, providerOrderId), sig)) return null;
  return { payment, order, credentials: ctx.credentials, providerOrderId, sig };
}

router.get(
  '/:providerOrderId',
  asyncHandler(async (req, res) => {
    const found = await load(req);
    if (!found) return res.status(404).type('html').send(page('Sandbox payment', '<h1 style="font-size:20px">This payment link is not valid.</h1>'));
    const { payment, order, providerOrderId, sig } = found;
    const amount = (Number(payment.amount) / 100).toFixed(2);
    const link = (result) => `${encodeURIComponent(providerOrderId)}/complete?result=${result}&sig=${sig}`;
    const button = 'display:block;padding:12px 16px;border-radius:10px;text-decoration:none;font-weight:600;margin-top:12px';
    res.type('html').send(
      page(
        'Sandbox payment',
        `<h1 style="font-size:20px;margin:8px 0">Order ${escapeHtml(order.orderNumber)}</h1>
<p style="font-size:28px;font-weight:700;margin:12px 0">${escapeHtml(amount)} ${escapeHtml(payment.currency)}</p>
<a href="${link('paid')}" style="${button};background:#1f4fd8;color:#fff">Approve payment</a>
<a href="${link('failed')}" style="${button};border:1px solid #d5d5cc;color:#1c1c1c">Decline payment</a>`
      )
    );
  })
);

router.get(
  '/:providerOrderId/complete',
  asyncHandler(async (req, res) => {
    const found = await load(req);
    if (!found || !found.payment.returnUrl) {
      return res.status(404).type('html').send(page('Sandbox payment', '<h1 style="font-size:20px">This payment link is not valid.</h1>'));
    }
    const { payment, credentials, providerOrderId } = found;
    const fields = sandbox.buildResult(credentials, {
      providerOrderId,
      status: req.query.result === 'paid' ? 'paid' : 'failed',
      amount: Number(payment.amount),
      currency: payment.currency,
    });
    const target = new URL(payment.returnUrl);
    for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
    res.redirect(302, target.toString());
  })
);

module.exports = router;
