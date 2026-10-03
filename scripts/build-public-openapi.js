'use strict';

/**
 * Writes docs/public-openapi.json — the OpenAPI description of the public API
 * (modules/publicApi), served at /public-docs and /public-docs.json.
 *
 *   node scripts/build-public-openapi.js
 *
 * The routes are listed here by hand, next to the scope each needs; run it
 * again after adding one. Request bodies are the dashboard's own (the public
 * routes reuse its validation), described here by their main fields.
 */

const fs = require('fs');
const path = require('path');

const uuid = { type: 'string', format: 'uuid' };
const money = { type: 'string', description: 'Integer minor units (piasters) as a string: "15000" is 150.00.' };
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ content: { 'application/json': { schema } } });
const param = (name, description, schema = uuid) => ({ name, in: 'path', required: true, description, schema });
const query = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
const errors = {
  401: { description: 'Missing or invalid API key', ...json(ref('Error')) },
  403: { description: 'The key lacks the scope, or its creator lacks the permission', ...json(ref('Error')) },
  422: { description: 'Validation failed', ...json(ref('Error')) },
  429: { description: 'Rate limit reached for this key', ...json(ref('Error')) },
};

function op({ tag, summary, scope, description, params = [], body, ok = 200, response, idempotent = false }) {
  const scopes = Array.isArray(scope) ? scope : scope ? [scope] : [];
  const parameters = [...params];
  if (idempotent) {
    parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' }, description: 'Repeat a request safely: the same key returns the first answer.' });
  }
  return {
    tags: [tag],
    summary,
    description: [description, scopes.length ? `**Scope:** ${scopes.map((s) => `\`${s}\``).join(' or ')}` : null].filter(Boolean).join('\n\n'),
    ...(parameters.length ? { parameters } : {}),
    ...(body ? { requestBody: { required: true, ...json(body) } } : {}),
    responses: {
      [ok]: { description: 'Success', ...(response ? json(response) : {}) },
      ...errors,
      ...(params.some((p) => p.in === 'path') ? { 404: { description: 'Not found', ...json(ref('Error')) } } : {}),
    },
    'x-scopes': scopes,
  };
}

const list = (key, item) => ({ type: 'object', properties: { [key]: { type: 'array', items: item }, nextCursor: { type: 'string', nullable: true } } });
const wrap = (key, item) => ({ type: 'object', properties: { [key]: item } });
const cursorParams = [query('limit', 'Page size (default 50).', { type: 'integer', minimum: 1, maximum: 200 }), query('cursor', 'The `nextCursor` of the previous page.')];

const orderId = param('orderId', 'Order id');
const W = 'orders:write';

const paths = {
  '/me': { get: op({ tag: 'Account', summary: 'The store and scopes of this key', response: ref('Me') }) },

  '/orders': {
    get: op({
      tag: 'Orders',
      summary: 'List orders',
      scope: 'orders:read',
      params: [
        ...cursorParams,
        query('status', 'Order stage.', { type: 'string', enum: ['awaiting_payment', 'pending_confirmation', 'needs_follow_up', 'ready_to_ship', 'shipped', 'out_for_delivery', 'delivery_failed', 'delivered', 'returned', 'cancelled'] }),
        query('created_from', 'Created at or after (ISO 8601).', { type: 'string', format: 'date-time' }),
        query('created_to', 'Created at or before (ISO 8601).', { type: 'string', format: 'date-time' }),
        query('updated_since', 'Changed at or after (ISO 8601) — for incremental sync.', { type: 'string', format: 'date-time' }),
        query('product_id', 'Only orders containing this product.', uuid),
        query('q', 'Search in order number, customer name and phone.'),
        query('paymentMethod', 'Payment method.', { type: 'string', enum: ['cod', 'card', 'wallet', 'bank_transfer'] }),
        query('source', 'Where the order came from.', { type: 'string', enum: ['store', 'funnel', 'manual', 'api', 'import', 'upsell'] }),
      ],
      response: list('orders', ref('Order')),
    }),
    post: op({ tag: 'Orders', summary: 'Create an order', scope: ['orders:create', W], body: ref('OrderCreate'), ok: 201, response: wrap('order', ref('Order')), idempotent: true, description: 'Prices, shipping, discounts and stock are worked out by the server exactly as for a storefront order. The order is recorded with source `api`.' }),
  },
  '/orders/by-number/{orderNumber}': { get: op({ tag: 'Orders', summary: 'Get an order by its number', scope: 'orders:read', params: [param('orderNumber', 'The number printed on the order', { type: 'string' })], response: wrap('order', ref('Order')) }) },
  '/orders/{orderId}': { get: op({ tag: 'Orders', summary: 'Get an order', scope: 'orders:read', params: [orderId], response: wrap('order', ref('Order')) }) },
  '/orders/{orderId}/status': {
    patch: op({ tag: 'Orders', summary: 'Move an order to another stage', scope: ['orders:update', W], params: [orderId], body: { type: 'object', required: ['status'], properties: { status: { type: 'string', description: 'The stage to move to; only the moves the dashboard allows are accepted.' }, reason: { type: 'string' }, carrierCode: { type: 'string' }, waybillNumber: { type: 'string' } } }, response: wrap('order', ref('Order')) }),
  },
  '/orders/{orderId}/confirmation': {
    post: op({ tag: 'Orders', summary: 'Record the confirmation call outcome', scope: ['orders:update', W], params: [orderId], body: { type: 'object', required: ['outcome'], properties: { outcome: { type: 'string', enum: ['confirmed', 'rejected', 'unreachable', 'postponed'] }, reason: { type: 'string' }, notes: { type: 'string' } } }, response: wrap('order', ref('Order')) }),
  },
  '/orders/{orderId}/cancel': { post: op({ tag: 'Orders', summary: 'Cancel an order', scope: ['orders:delete', W], params: [orderId], body: { type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } }, response: wrap('order', ref('Order')) }) },
  '/orders/{orderId}/notes': {
    get: op({ tag: 'Orders', summary: 'List an order\'s notes', scope: 'orders:read', params: [orderId], response: list('notes', ref('OrderNote')) }),
    post: op({ tag: 'Orders', summary: 'Add a note to an order', scope: ['orders:update', W], params: [orderId], body: { type: 'object', required: ['body'], properties: { body: { type: 'string' }, visibility: { type: 'string', enum: ['internal', 'public'], description: '`public` notes are shown to the customer on the tracking page.' } } }, ok: 201, response: wrap('note', ref('OrderNote')) }),
  },
  '/orders/{orderId}/tracking': { post: op({ tag: 'Orders', summary: 'Add tracking to an order', scope: ['orders:update', W], params: [orderId], body: ref('ShipmentCreate'), ok: 201, response: wrap('shipment', ref('Shipment')), description: 'Records the shipment an outside fulfilment system booked. Same as `POST /orders/{orderId}/shipments`.' }) },
  '/orders/{orderId}/shipments': {
    get: op({ tag: 'Orders', summary: 'List an order\'s shipments', scope: 'orders:read', params: [orderId], response: list('shipments', ref('Shipment')) }),
    post: op({ tag: 'Orders', summary: 'Create a shipment', scope: ['orders:update', W], params: [orderId], body: ref('ShipmentCreate'), ok: 201, response: wrap('shipment', ref('Shipment')) }),
  },
  '/orders/{orderId}/shipments/{shipmentId}': { patch: op({ tag: 'Orders', summary: 'Update a shipment\'s status', scope: ['orders:update', W], params: [orderId, param('shipmentId', 'Shipment id')], body: { type: 'object', properties: { status: { type: 'string', enum: ['created', 'picked_up', 'in_transit', 'out_for_delivery', 'delivered', 'failed', 'returned', 'cancelled'] }, trackingNumber: { type: 'string' }, trackingUrl: { type: 'string' } } }, response: wrap('shipment', ref('Shipment')) }) },
  '/orders/{orderId}/cod-collected': { post: op({ tag: 'Orders', summary: 'Mark the cash as collected', scope: ['orders:update', W], params: [orderId], response: wrap('order', ref('Order')) }) },

  '/products': {
    get: op({ tag: 'Products', summary: 'List products', scope: 'products:read', params: [...cursorParams, query('status', 'draft, active, archived, or a comma-separated list.'), query('q', 'Search by name or SKU.'), query('collectionId', 'Only products of this category.', uuid)], response: list('products', ref('Product')) }),
    post: op({ tag: 'Products', summary: 'Create a product', scope: 'products:create', body: ref('ProductWrite'), ok: 201, response: { type: 'object', properties: { product: ref('Product'), variant: ref('Variant') } } }),
  },
  '/products/sku/{sku}/stock': {
    patch: op({ tag: 'Products', summary: 'Set or move the stock of a SKU', scope: 'products:update', params: [param('sku', 'The variant\'s SKU', { type: 'string' })], body: { type: 'object', description: 'Exactly one of `stock` (the new count on hand) or `delta` (a change).', properties: { stock: { type: 'integer', minimum: 0 }, delta: { type: 'integer' }, reason: { type: 'string' } } }, response: wrap('variant', { type: 'object', properties: { id: uuid, productId: uuid, sku: { type: 'string' }, stockOnHand: { type: 'integer' }, reservedStock: { type: 'integer' }, available: { type: 'integer' } } }) }),
  },
  '/products/{productId}': {
    get: op({ tag: 'Products', summary: 'Get a product with its variants', scope: 'products:read', params: [param('productId', 'Product id')], response: wrap('product', ref('Product')) }),
    patch: op({ tag: 'Products', summary: 'Update a product', scope: 'products:update', params: [param('productId', 'Product id')], body: ref('ProductWrite'), response: wrap('product', ref('Product')) }),
    delete: op({ tag: 'Products', summary: 'Archive a product', scope: 'products:delete', params: [param('productId', 'Product id')], description: 'The product leaves the store and can be restored from the dashboard.' }),
  },

  '/categories': {
    get: op({ tag: 'Categories', summary: 'List categories', scope: 'categories:read', response: list('categories', ref('Category')) }),
    post: op({ tag: 'Categories', summary: 'Create a category', scope: 'categories:create', body: ref('CategoryWrite'), ok: 201, response: wrap('category', ref('Category')) }),
  },
  '/categories/{collectionId}': {
    get: op({ tag: 'Categories', summary: 'Get a category', scope: 'categories:read', params: [param('collectionId', 'Category id')], response: wrap('category', ref('Category')) }),
    patch: op({ tag: 'Categories', summary: 'Update a category', scope: 'categories:update', params: [param('collectionId', 'Category id')], body: ref('CategoryWrite'), response: wrap('category', ref('Category')) }),
    delete: op({ tag: 'Categories', summary: 'Delete a category', scope: 'categories:delete', params: [param('collectionId', 'Category id')] }),
  },

  '/customers': { get: op({ tag: 'Customers', summary: 'List customers', scope: 'customers:read', params: cursorParams, response: list('customers', ref('Customer')), description: 'Phone numbers are partly hidden unless the teammate who created the key may see them in full.' }) },
  '/customers/{customerId}': { get: op({ tag: 'Customers', summary: 'Get a customer', scope: 'customers:read', params: [param('customerId', 'Customer id')], response: wrap('customer', ref('Customer')) }) },

  '/discounts': {
    get: op({ tag: 'Discounts', summary: 'List discount codes', scope: ['discounts:read', 'discounts:write'], response: list('discounts', ref('Discount')) }),
    post: op({ tag: 'Discounts', summary: 'Create a discount code', scope: 'discounts:write', body: ref('DiscountWrite'), ok: 201, response: wrap('discount', ref('Discount')) }),
  },
  '/discounts/{discountId}': {
    get: op({ tag: 'Discounts', summary: 'Get a discount code', scope: ['discounts:read', 'discounts:write'], params: [param('discountId', 'Discount id')], response: wrap('discount', ref('Discount')) }),
    patch: op({ tag: 'Discounts', summary: 'Update a discount code', scope: 'discounts:write', params: [param('discountId', 'Discount id')], body: ref('DiscountWrite'), response: wrap('discount', ref('Discount')) }),
    delete: op({ tag: 'Discounts', summary: 'Archive a discount code', scope: 'discounts:write', params: [param('discountId', 'Discount id')] }),
  },

  '/shipping-areas': {
    get: op({ tag: 'Shipping areas', summary: 'List shipping areas and their prices', scope: ['shipping_areas:read', 'shipping_areas:write'], response: list('shippingAreas', ref('ShippingArea')) }),
    patch: op({ tag: 'Shipping areas', summary: 'Update many prices at once', scope: 'shipping_areas:write', description: 'All or nothing: every `rateId` is checked before any rate is changed.', body: { type: 'object', required: ['rates'], properties: { rates: { type: 'array', maxItems: 200, items: { type: 'object', required: ['rateId'], properties: { rateId: uuid, name: { type: 'string' }, config: { type: 'object', description: 'The price, in the shape of the rate\'s type.' }, isActive: { type: 'boolean' } } } } } }, response: list('rates', ref('ShippingRate')) }),
  },

  '/webhooks': {
    get: op({ tag: 'Webhooks', summary: 'List webhook endpoints', scope: 'webhooks:write', response: list('endpoints', ref('WebhookEndpoint')) }),
    post: op({ tag: 'Webhooks', summary: 'Register a webhook endpoint', scope: 'webhooks:write', body: ref('WebhookWrite'), ok: 201, response: { type: 'object', properties: { endpoint: ref('WebhookEndpoint'), secret: { type: 'string', description: 'The signing secret. Shown only in this answer.' } } } }),
  },
  '/webhooks/events': { get: op({ tag: 'Webhooks', summary: 'The events an endpoint can subscribe to', scope: 'webhooks:write' }) },
  '/webhooks/{endpointId}': {
    patch: op({ tag: 'Webhooks', summary: 'Update a webhook endpoint', scope: 'webhooks:write', params: [param('endpointId', 'Endpoint id')], body: ref('WebhookWrite'), response: wrap('endpoint', ref('WebhookEndpoint')) }),
    delete: op({ tag: 'Webhooks', summary: 'Delete a webhook endpoint', scope: 'webhooks:write', params: [param('endpointId', 'Endpoint id')] }),
  },

  '/analytics/summary': { get: op({ tag: 'Analytics', summary: 'Sales summary for a period', scope: 'analytics:read', params: [query('from', 'Start (ISO 8601).', { type: 'string', format: 'date-time' }), query('to', 'End (ISO 8601).', { type: 'string', format: 'date-time' })] }) },
};

const schemas = {
  Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string', example: 'VALIDATION_ERROR' }, message: { type: 'string' }, details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } }, requestId: { type: 'string' } } } } },
  Me: { type: 'object', properties: { workspaceId: uuid, apiKey: { type: 'object', properties: { id: uuid, name: { type: 'string' }, keyPrefix: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } } }, actingAs: { type: 'object', properties: { id: uuid, fullName: { type: 'string' } } } } },
  Order: {
    type: 'object',
    description: 'An order as the public API returns it. Money fields are minor-unit strings.',
    properties: { id: uuid, orderNumber: { type: 'string' }, status: { type: 'string', description: 'The order stage.' }, currency: { type: 'string', example: 'EGP' }, totalAmount: money, subtotalAmount: money, shippingAmount: money, discountAmount: money, paymentMethod: { type: 'string' }, customer: { type: 'object', properties: { fullName: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string', nullable: true } } }, shippingAddress: { type: 'object' }, items: { type: 'array', items: { type: 'object', properties: { productId: uuid, variantId: uuid, sku: { type: 'string' }, name: { type: 'string' }, quantity: { type: 'integer' }, unitPrice: money } } }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } },
  },
  OrderCreate: {
    type: 'object',
    required: ['items', 'contact', 'paymentMethod'],
    properties: {
      items: { type: 'array', minItems: 1, items: { type: 'object', required: ['variantId', 'quantity'], properties: { variantId: uuid, offerId: uuid, quantity: { type: 'integer', minimum: 1 } } } },
      contact: { type: 'object', required: ['fullName', 'phone'], properties: { fullName: { type: 'string' }, phone: { type: 'string' }, alternatePhone: { type: 'string' }, email: { type: 'string' } } },
      shippingAddress: { type: 'object', required: ['country', 'city', 'addressLine'], properties: { country: { type: 'string', example: 'EG' }, province: { type: 'string' }, city: { type: 'string' }, addressLine: { type: 'string' }, postalCode: { type: 'string' }, notes: { type: 'string' } } },
      paymentMethod: { type: 'string', enum: ['cod', 'card', 'wallet', 'bank_transfer'] },
      discountCode: { type: 'string' },
      notes: { type: 'string' },
    },
  },
  OrderNote: { type: 'object', properties: { id: uuid, orderId: uuid, body: { type: 'string' }, visibility: { type: 'string', enum: ['internal', 'public'] }, createdAt: { type: 'string', format: 'date-time' } } },
  Shipment: { type: 'object', properties: { id: uuid, carrierCode: { type: 'string' }, waybillNumber: { type: 'string', nullable: true }, trackingCode: { type: 'string' }, trackingUrl: { type: 'string', nullable: true }, status: { type: 'string' }, shippedAt: { type: 'string', format: 'date-time', nullable: true }, deliveredAt: { type: 'string', format: 'date-time', nullable: true } } },
  ShipmentCreate: { type: 'object', required: ['carrierCode'], properties: { carrierCode: { type: 'string', example: 'manual' }, trackingNumber: { type: 'string' }, trackingUrl: { type: 'string' } } },
  Product: { type: 'object', properties: { id: uuid, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string', nullable: true }, status: { type: 'string', enum: ['draft', 'active', 'archived'] }, images: { type: 'array', items: { type: 'object' } }, variants: { type: 'array', items: ref('Variant') }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
  Variant: { type: 'object', properties: { id: uuid, productId: uuid, sku: { type: 'string', nullable: true }, priceAmount: money, compareAtAmount: { ...money, nullable: true }, stockOnHand: { type: 'integer' }, reservedStock: { type: 'integer' }, optionValues: { type: 'object' }, status: { type: 'string' } } },
  ProductWrite: { type: 'object', description: 'The fields of the dashboard\'s product form. `variant` creates the first variant along with the product.', properties: { name: { type: 'string' }, description: { type: 'string' }, status: { type: 'string', enum: ['draft', 'active'] }, variant: { type: 'object', properties: { sku: { type: 'string' }, priceAmount: { type: 'integer', description: 'Minor units.' }, stockOnHand: { type: 'integer' } } } } },
  Category: { type: 'object', properties: { id: uuid, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string', nullable: true }, parentId: { ...uuid, nullable: true } } },
  CategoryWrite: { type: 'object', properties: { name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' }, parentId: { ...uuid, nullable: true } } },
  Customer: { type: 'object', properties: { id: uuid, fullName: { type: 'string', nullable: true }, phoneNormalized: { type: 'string' }, phoneRaw: { type: 'string' }, email: { type: 'string', nullable: true }, totalOrders: { type: 'integer' }, totalRejectedOrders: { type: 'integer' }, isBlacklisted: { type: 'boolean' }, createdAt: { type: 'string', format: 'date-time' } } },
  Discount: { type: 'object', properties: { id: uuid, code: { type: 'string' }, type: { type: 'string', enum: ['percentage', 'fixed', 'free_shipping', 'buy_x_get_y'] }, value: { type: 'string', description: 'Basis points for a percentage (1000 = 10%), minor units for a fixed amount.' }, status: { type: 'string' }, usageCount: { type: 'integer' }, startsAt: { type: 'string', format: 'date-time', nullable: true }, endsAt: { type: 'string', format: 'date-time', nullable: true } } },
  DiscountWrite: { type: 'object', properties: { code: { type: 'string' }, type: { type: 'string', enum: ['percentage', 'fixed', 'free_shipping', 'buy_x_get_y'] }, value: { type: 'integer' }, minimumSubtotal: { type: 'integer' }, usageLimit: { type: 'integer' }, startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' } } },
  ShippingArea: { type: 'object', properties: { id: uuid, name: { type: 'string' }, countries: { type: 'array', items: { type: 'string' } }, regions: { type: 'array', items: { type: 'string' }, description: 'The governorates this area covers.' }, isActive: { type: 'boolean' }, rates: { type: 'array', items: ref('ShippingRate') } } },
  ShippingRate: { type: 'object', properties: { id: uuid, zoneId: uuid, name: { type: 'string' }, rateType: { type: 'string', enum: ['flat', 'weight_based', 'quantity_based', 'order_value_based', 'free'] }, config: { type: 'object' }, isActive: { type: 'boolean' } } },
  WebhookEndpoint: { type: 'object', properties: { id: uuid, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, isActive: { type: 'boolean' }, secretHint: { type: 'string' } } },
  WebhookWrite: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string', example: 'order.created' } }, isActive: { type: 'boolean' } } },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'ZIMOS Public API',
    version: '1.0.0',
    description: [
      'The API a store\'s own systems and partners use: orders, products, categories, customers, discounts, shipping areas and webhooks.',
      '',
      '**Authentication.** Create a key in the dashboard under *Settings → Developers* and send it as `Authorization: Bearer zk_…` (or in an `Api-Key` header). A key belongs to one store, acts as the teammate who created it, and can do only what its scopes allow.',
      '',
      '**Rate limit.** 60 requests a minute per key unless set otherwise. Every answer carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; past the limit the answer is `429`.',
      '',
      '**Money** is an integer in the smallest unit of the currency (piasters), returned as a string. **Percentages** are basis points (100 = 1%).',
      '',
      '**Paging.** Lists return `nextCursor`; pass it back as `cursor` for the next page.',
      '',
      '**Errors** share one envelope: `{ "error": { "code", "message", "details", "requestId" } }`.',
    ].join('\n'),
  },
  servers: [{ url: '/api/public/v1', description: 'This server' }],
  security: [{ bearerKey: [] }, { apiKeyHeader: [] }],
  tags: ['Account', 'Orders', 'Products', 'Categories', 'Customers', 'Discounts', 'Shipping areas', 'Webhooks', 'Analytics'].map((name) => ({ name })),
  paths,
  components: {
    securitySchemes: {
      bearerKey: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer zk_…' },
      apiKeyHeader: { type: 'apiKey', in: 'header', name: 'Api-Key' },
    },
    schemas,
  },
};

const out = path.join(__dirname, '..', 'docs', 'public-openapi.json');
fs.writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);
const count = Object.values(paths).reduce((n, methods) => n + Object.keys(methods).length, 0);
console.log(`Wrote ${path.relative(process.cwd(), out)}: ${Object.keys(paths).length} paths, ${count} operations`);
