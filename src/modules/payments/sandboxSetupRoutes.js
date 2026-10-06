'use strict';

const { Router } = require('express');
const asyncHandler = require('express-async-handler');
const gatewayRuntime = require('./gatewayRuntime');
const sandbox = require('./gateways/sandbox');

/**
 * The sandbox gateway's card setup page (gateways/sandboxCardSetup.js):
 * "save this card" with no payment, for a subscription's card update and a
 * free trial. Public like the sandbox payment page; the signed link is the
 * only credential, and it has no script.
 *
 * Mounted at /api/v1/sandbox-pay/setup (sandboxPayRoutes.js).
 */
const router = Router();

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox card</title></head>
<body style="font-family:system-ui,sans-serif;background:#f4f4f0;margin:0;padding:48px 16px;color:#1c1c1c">
<main style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e3e3dc;border-radius:16px;padding:28px;text-align:center">
<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a6d1c">Sandbox — no card, no money</p>
${body}</main></body></html>`;
}

const invalid = (res) => res.status(404).type('html').send(page('<h1 style="font-size:20px">This card link is not valid.</h1>'));

async function load(req) {
  const { workspaceId, reference } = req.params;
  const returnUrl = typeof req.query.ret === 'string' ? req.query.ret : '';
  const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
  if (!/^[0-9a-f-]{36}$/.test(workspaceId) || !returnUrl) return null;
  let ctx;
  try {
    ctx = await gatewayRuntime.contextFor(workspaceId, sandbox.code);
  } catch {
    return null;
  }
  if (!sandbox.safeEqualHex(sandbox.signSetupPage(ctx.credentials, workspaceId, reference, returnUrl), sig)) return null;
  return { credentials: ctx.credentials, workspaceId, reference, returnUrl, sig };
}

router.get(
  '/:workspaceId/:reference',
  asyncHandler(async (req, res) => {
    const found = await load(req);
    if (!found) return invalid(res);
    const query = `ret=${encodeURIComponent(found.returnUrl)}&sig=${found.sig}`;
    const link = (result) => `${encodeURIComponent(found.reference)}/done?result=${result}&${query}`;
    const button = 'display:block;padding:12px 16px;border-radius:10px;text-decoration:none;font-weight:600;margin-top:12px';
    res.type('html').send(
      page(`<h1 style="font-size:20px;margin:8px 0">Save a card</h1>
<p style="color:#555;margin:8px 0 4px">Sandbox •••• 4242 is kept for the next payments. Nothing is charged now.</p>
<a href="${link('saved')}" style="${button};background:#1f4fd8;color:#fff">Save card</a>
<a href="${link('cancelled')}" style="${button};border:1px solid #d5d5cc;color:#1c1c1c">Cancel</a>`)
    );
  })
);

router.get(
  '/:workspaceId/:reference/done',
  asyncHandler(async (req, res) => {
    const found = await load(req);
    if (!found) return invalid(res);
    const fields = sandbox.buildSetupResult(found.credentials, { reference: found.reference, status: req.query.result === 'saved' ? 'saved' : 'cancelled' });
    const target = new URL(found.returnUrl);
    for (const [key, value] of Object.entries(fields)) target.searchParams.set(key, value);
    res.redirect(302, target.toString());
  })
);

module.exports = router;
