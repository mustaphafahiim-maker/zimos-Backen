'use strict';

const { Router } = require('express');
const db = require('../../db/models');
const logger = require('../../core/utils/logger');
const { PERMISSIONS } = require('../../core/security/permissions');
const { authenticateApiKey, apiKeyLimiter } = require('../apiKeys/apiKeyAuth');

/*
 * The store's MCP server (Lightfunnels' MCP; spec-gaps item 179): Claude,
 * ChatGPT or any MCP client works with the store through a store API key.
 *
 *   POST /api/public/v1/mcp     Authorization: Bearer <api key>
 *   JSON-RPC 2.0, the MCP "Streamable HTTP" transport answered as plain JSON
 *   (no server-sent events): initialize, notifications/initialized, ping,
 *   tools/list, tools/call. GET/DELETE answer 405 (no stream, no session).
 *
 * Every tool runs as the key: its creator's role AND the key's scopes must
 * allow it (apiKeyAuth.hasPermission), plus the scope named per tool, the
 * same rules as the public REST API. Nothing here bypasses a service.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'zimos-store', version: '1.0.0' };

const err = (code, message, data) => ({ code, message, ...(data ? { data } : {}) });
const toolError = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });

class ToolDenied extends Error {}
function need(req, { scopes, permission }) {
  const held = (req.apiKey && req.apiKey.scopes) || [];
  if (scopes && !scopes.some((s) => held.includes(s))) throw new ToolDenied(`This API key needs the "${scopes[0]}" scope for this tool`);
  if (permission && !req.tenant.hasPermission(permission)) throw new ToolDenied('The API key (or the teammate who made it) is not allowed to do this');
}

const money = (amount, currency) => (amount === null || amount === undefined ? null : { amount: String(amount), currency });

const TOOLS = [
  {
    name: 'list_products',
    description: 'List the store\'s products with their prices and stock. Optional search by name, and status filter.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Part of the product name' },
        status: { type: 'string', enum: ['active', 'draft', 'archived'] },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    async run(req, args) {
      need(req, { scopes: ['products:read', 'products:update'], permission: PERMISSIONS.PRODUCTS_VIEW });
      const { products } = await require('../catalog/catalogService').listProducts(req.tenant.workspaceId, {
        q: args.query || undefined,
        status: args.status || undefined,
        limit: Math.min(Math.max(Number(args.limit) || 20, 1), 50),
      });
      return {
        products: products.map((p) => {
          const j = typeof p.toJSON === 'function' ? p.toJSON() : p;
          return {
            id: j.id, name: j.name, status: j.status, slug: j.slug || null,
            variants: (j.variants || []).map((v) => ({ id: v.id, sku: v.sku || null, price: money(v.priceAmount, v.currency || j.currency), stockOnHand: v.stockOnHand ?? null })),
          };
        }),
      };
    },
  },
  {
    name: 'list_orders',
    description: 'List recent orders, newest first. Filter by text (order number, name, phone) and by date.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Order number, customer name, email or phone (or its last digits)' },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
      additionalProperties: false,
    },
    async run(req, args) {
      need(req, { scopes: ['orders:read', 'orders:write', 'orders:update'], permission: PERMISSIONS.ORDERS_VIEW });
      const q = args.query && String(args.query).trim().length >= 2 ? String(args.query).trim() : undefined;
      const date = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
      const { orders, nextCursor } = await require('../publicApi/publicOrderService').listOrders(req.tenant.workspaceId, {
        q, from: date(args.from), to: date(args.to), limit: Math.min(Math.max(Number(args.limit) || 20, 1), 50),
      });
      return { orders, nextCursor };
    },
  },
  {
    name: 'get_order',
    description: 'One order with its lines, customer, address, payments and shipments, by id or by order number.',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' }, orderNumber: { type: 'string' } },
      additionalProperties: false,
    },
    async run(req, args) {
      need(req, { scopes: ['orders:read', 'orders:write', 'orders:update'], permission: PERMISSIONS.ORDERS_VIEW });
      const svc = require('../publicApi/publicOrderService');
      if (args.orderId) return { order: await svc.getOrder(req.tenant.workspaceId, String(args.orderId)) };
      if (args.orderNumber) return { order: await svc.getOrderByNumber(req.tenant.workspaceId, String(args.orderNumber)) };
      throw new ToolDenied('Give orderId or orderNumber');
    },
  },
  {
    name: 'check_pages',
    description: 'Check the store\'s funnels for problems before publishing: broken step maps, pages selling nothing, buttons going nowhere, images without descriptions. One funnel, or every funnel.',
    inputSchema: { type: 'object', properties: { funnelId: { type: 'string' } }, additionalProperties: false },
    async run(req, args) {
      need(req, { scopes: ['funnels:read', 'funnels:write'], permission: PERMISSIONS.FUNNELS_MANAGE });
      const ws = req.tenant.workspaceId;
      const funnels = await db.Funnel.findAll({ where: { workspaceId: ws, ...(args.funnelId ? { id: String(args.funnelId) } : {}) }, attributes: ['id', 'name', 'status'], order: [['createdAt', 'DESC']], limit: 50 });
      const extras = require('../funnels/funnelExtras');
      const out = [];
      for (const f of funnels) {
        const { issues } = await extras.listIssues(ws, f.id);
        out.push({ funnelId: f.id, name: f.name, status: f.status, fatal: issues.filter((i) => i.severity === 'fatal').length, warnings: issues.filter((i) => i.severity !== 'fatal').length, issues });
      }
      return { funnels: out };
    },
  },
  {
    name: 'create_draft_funnel',
    description: 'Create a new funnel as a draft (not published) with a name. The merchant reviews and publishes it in the dashboard.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['name'],
      additionalProperties: false,
    },
    async run(req, args) {
      need(req, { scopes: ['funnels:write'], permission: PERMISSIONS.FUNNELS_MANAGE });
      const name = String(args.name || '').trim().slice(0, 200);
      if (!name) throw new ToolDenied('A name is required');
      const funnel = await require('../funnels/funnelsService').createFunnel(req.tenant.workspaceId, { name }, req);
      const j = typeof funnel.toJSON === 'function' ? funnel.toJSON() : funnel.funnel || funnel;
      return { funnel: { id: j.id, name: j.name, status: j.status, subdomain: j.subdomain || null } };
    },
  },
];

const listed = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

async function handle(req, msg) {
  const { id, method, params = {} } = msg || {};
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (e) => ({ jsonrpc: '2.0', id: id === undefined ? null : id, error: e });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return fail(err(-32600, 'Invalid request'));
  // Notifications get no answer.
  if (id === undefined || id === null) return null;

  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Tools for one Zimos store, acting as its API key. Prices are strings in minor units (e.g. "45000" EGP = 450.00 EGP). Funnels you create stay drafts until the merchant publishes them.',
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: listed });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(err(-32602, `Unknown tool "${params.name}"`));
      try {
        return reply(ok(await tool.run(req, params.arguments || {})));
      } catch (e) {
        // A refusal or a store error is the tool's answer, so the model can read it and adjust.
        if (e instanceof ToolDenied || e.isOperational) return reply(toolError(e.message));
        logger.error('[mcp] tool failed', { tool: tool.name, workspaceId: req.tenant.workspaceId, message: e.message });
        return reply(toolError('The tool failed unexpectedly'));
      }
    }
    default:
      return fail(err(-32601, `Method "${method}" not found`));
  }
}

// Mounted at /api/public/v1/mcp, ahead of the public REST API.
const router = Router();
router.post('/', authenticateApiKey, apiKeyLimiter, async (req, res, next) => {
  try {
    const body = req.body;
    if (Array.isArray(body)) {
      const answers = (await Promise.all(body.map((m) => handle(req, m)))).filter(Boolean);
      return answers.length ? res.json(answers) : res.status(202).end();
    }
    const answer = await handle(req, body);
    return answer ? res.json(answer) : res.status(202).end();
  } catch (e) {
    return next(e);
  }
});
router.all('/', (req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: err(-32000, 'Use POST (no event stream is offered)') }));

module.exports = { router, TOOLS };
