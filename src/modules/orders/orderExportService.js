'use strict';

const db = require('../../db/models');
const { toDisplay } = require('../../core/utils/money');
const orderService = require('./orderService');

/**
 * Orders as a CSV file: the orders the list would show under the same search,
 * dates, stage and sort, with the columns the merchant picked, either one row
 * per order or one row per order line.
 *
 * It pages through orderService.listOrders rather than querying on its own,
 * so the file can never disagree with the screen about which orders match.
 * Rows are produced a page at a time and written as they come, so a large
 * export holds one page in memory, not the whole file.
 */

const PAGE_SIZE = 200;
// A ceiling, so one request cannot read the whole table: the file says so in
// its last line when it stops here, and a date range narrows it.
const MAX_ORDERS = 20000;

const money = (amount) => (amount === null || amount === undefined ? '' : toDisplay(String(amount)));
const contact = (o) => o.contactSnapshot || {};
const address = (o) => o.shippingAddressSnapshot || {};

// The words the dashboard shows for each code (pages/orders/orderLabels.ts),
// so a file reads like the screen it was exported from. [English, Arabic].
const LABELS = {
  stage: {
    awaiting_payment: ['Awaiting payment', 'في انتظار الدفع'],
    pending_confirmation: ['New', 'جديد'],
    needs_follow_up: ['Follow up', 'للمتابعة'],
    ready_to_ship: ['Ready to ship', 'جاهز للشحن'],
    shipped: ['Shipped', 'تم الشحن'],
    out_for_delivery: ['Out for delivery', 'خرج للتوصيل'],
    delivery_failed: ['Delivery failed', 'فشل التوصيل'],
    delivered: ['Delivered', 'تم التسليم'],
    returned: ['Returned', 'مرتجع'],
    cancelled: ['Cancelled', 'ملغي'],
  },
  confirmation: {
    pending: ['Awaiting call', 'في انتظار المكالمة'],
    confirmed: ['Confirmed', 'مؤكد'],
    rejected: ['Rejected', 'مرفوض'],
    unreachable: ['Unreachable', 'لم يتم الوصول إليه'],
    postponed: ['Postponed', 'مؤجل'],
  },
  financial: {
    pending: ['Unpaid', 'غير مدفوع'],
    partially_paid: ['Partially paid', 'مدفوع جزئيًا'],
    paid: ['Paid', 'مدفوع'],
    failed: ['Payment failed', 'فشل الدفع'],
    refunded: ['Refunded', 'مسترد'],
    partially_refunded: ['Partially refunded', 'مسترد جزئيًا'],
  },
  fulfillment: {
    unfulfilled: ['Not shipped', 'لم يُشحن'],
    partially_fulfilled: ['Partially shipped', 'شُحن جزئيًا'],
    fulfilled: ['Fulfilled', 'مكتمل'],
    returned: ['Returned', 'مرتجع'],
  },
  shipment: {
    created: ['Created', 'تم الإنشاء'],
    picked_up: ['Picked up', 'تم الاستلام من المتجر'],
    in_transit: ['In transit', 'في الطريق'],
    out_for_delivery: ['Out for delivery', 'خرج للتوصيل'],
    delivered: ['Delivered', 'تم التسليم'],
    failed: ['Failed', 'فشل'],
    returned: ['Returned', 'مرتجع'],
    cancelled: ['Cancelled', 'ملغية'],
  },
  payment: {
    cod: ['Cash on delivery', 'الدفع عند الاستلام'],
    card: ['Card', 'بطاقة'],
    wallet: ['Wallet', 'محفظة إلكترونية'],
    paypal: ['PayPal', 'باي بال'],
    bank_transfer: ['Bank transfer', 'تحويل بنكي'],
  },
  source: {
    store: ['Store', 'المتجر'],
    funnel: ['Funnel', 'مسار بيع'],
  },
};

/** What one file is written with: its language and the store's own clock. */
function exportContext({ lang = 'en', timezone = 'UTC' } = {}) {
  // sv-SE writes a date as 2026-10-03 12:02:34, which every spreadsheet sorts.
  const clockFor = (timeZone) => new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'medium' });
  let clock;
  try {
    clock = clockFor(timezone);
  } catch {
    clock = clockFor('UTC');
  }
  return {
    lang,
    date: (value) => (value ? clock.format(new Date(value)) : ''),
    // An unknown code (a new stage, a courier's own word) is written as it is.
    label: (group, code) => {
      const words = LABELS[group] && LABELS[group][code];
      return words ? words[lang === 'ar' ? 1 : 0] : code || '';
    },
  };
}

function variantText(options) {
  if (!options || typeof options !== 'object') return '';
  return Object.entries(options)
    .map(([name, value]) => `${name}: ${value}`)
    .join(', ');
}

function itemsSummary(o) {
  return (o.items || [])
    .map((i) => {
      const variant = variantText(i.variantOptionsSnapshot);
      return `${i.quantity} x ${i.productNameSnapshot}${variant ? ` (${variant})` : ''}`;
    })
    .join(' | ');
}

/**
 * Every column a file can carry. `value(order, item, x)` — `item` is the order
 * line on a row-per-item export and null otherwise (the `item: true` columns
 * are the ones that only mean something per line), `x` the exportContext.
 */
const COLUMNS = [
  { key: 'orderNumber', en: 'Order number', ar: 'رقم الطلب', value: (o) => o.orderNumber },
  { key: 'createdAt', en: 'Date', ar: 'التاريخ', value: (o, i, x) => x.date(o.createdAt) },
  { key: 'stage', en: 'Stage', ar: 'المرحلة', value: (o, i, x) => x.label('stage', o.stage) },
  { key: 'confirmationState', en: 'Confirmation', ar: 'التأكيد', value: (o, i, x) => x.label('confirmation', o.confirmationState) },
  { key: 'financialState', en: 'Payment state', ar: 'حالة الدفع', value: (o, i, x) => x.label('financial', o.financialState) },
  { key: 'fulfillmentState', en: 'Fulfilment', ar: 'حالة الشحن', value: (o, i, x) => x.label('fulfillment', o.fulfillmentState) },
  { key: 'customerName', en: 'Customer', ar: 'العميل', value: (o) => contact(o).fullName },
  { key: 'phone', en: 'Phone', ar: 'الموبايل', value: (o) => contact(o).phone },
  { key: 'alternatePhone', en: 'Alternate phone', ar: 'موبايل بديل', value: (o) => contact(o).alternatePhone },
  { key: 'email', en: 'Email', ar: 'البريد الإلكتروني', value: (o) => contact(o).email },
  { key: 'country', en: 'Country', ar: 'الدولة', value: (o) => address(o).country },
  {
    key: 'region',
    en: 'Governorate',
    ar: 'المحافظة',
    value: (o) => address(o).region || address(o).province || address(o).governorate,
  },
  { key: 'city', en: 'City', ar: 'المدينة', value: (o) => address(o).city },
  { key: 'address', en: 'Address', ar: 'العنوان', value: (o) => address(o).addressLine },
  // One cell for couriers that take the address whole: street, area/city, governorate.
  {
    key: 'fullAddress',
    en: 'Full address',
    ar: 'العنوان كامل',
    value: (o, i, x) => [address(o).addressLine, address(o).city, byKey.get('region').value(o, i, x)].filter((v) => v && String(v).trim()).join('، '),
  },
  { key: 'addressNotes', en: 'Address notes', ar: 'ملاحظات العنوان', value: (o) => address(o).notes },
  { key: 'paymentMethod', en: 'Payment method', ar: 'طريقة الدفع', value: (o, i, x) => x.label('payment', o.paymentMethod) },
  { key: 'currency', en: 'Currency', ar: 'العملة', value: (o) => o.currency },
  { key: 'subtotal', en: 'Subtotal', ar: 'إجمالي المنتجات', value: (o) => money(o.subtotalAmount) },
  { key: 'discount', en: 'Discount', ar: 'الخصم', value: (o) => money(o.discountAmount) },
  { key: 'shipping', en: 'Shipping', ar: 'الشحن', value: (o) => money(o.shippingAmount) },
  { key: 'tax', en: 'Tax', ar: 'الضريبة', value: (o) => money(o.taxAmount) },
  { key: 'total', en: 'Total', ar: 'الإجمالي', value: (o) => money(o.totalAmount) },
  // What the courier collects at the door: the unpaid part of a cash-on-delivery order, else nothing.
  {
    key: 'codAmount',
    en: 'Amount to collect',
    ar: 'المبلغ المطلوب تحصيله',
    value: (o) => money(o.paymentMethod === 'cod' ? Math.max(0, Number(o.totalAmount || 0) - Number(o.amountPaid || 0)) : 0),
  },
  { key: 'amountPaid', en: 'Paid', ar: 'المدفوع', value: (o) => money(o.amountPaid) },
  { key: 'amountRefunded', en: 'Refunded', ar: 'المسترد', value: (o) => money(o.amountRefunded) },
  {
    key: 'discountCodes',
    en: 'Discount code',
    ar: 'كود الخصم',
    value: (o) =>
      (o.discountsSnapshot || [])
        .map((d) => d.code)
        .filter(Boolean)
        .join(', '),
  },
  { key: 'itemsCount', en: 'Items', ar: 'عدد القطع', value: (o) => (o.items || []).reduce((n, i) => n + i.quantity, 0) },
  { key: 'items', en: 'Products', ar: 'المنتجات', value: (o) => itemsSummary(o) },
  { key: 'source', en: 'Source', ar: 'المصدر', value: (o, i, x) => x.label('source', o.funnelId ? 'funnel' : 'store') },
  { key: 'carrier', en: 'Courier', ar: 'شركة الشحن', value: (o) => (o.shipment ? o.shipment.carrierCode : '') },
  { key: 'waybillNumber', en: 'Waybill', ar: 'رقم البوليصة', value: (o) => (o.shipment ? o.shipment.waybillNumber : '') },
  { key: 'trackingUrl', en: 'Tracking link', ar: 'رابط التتبع', value: (o) => (o.shipment ? o.shipment.trackingUrl : '') },
  {
    key: 'shipmentStatus',
    en: 'Shipment status',
    ar: 'حالة الشحنة',
    value: (o, i, x) => (o.shipment ? x.label('shipment', o.shipment.status) : ''),
  },
  { key: 'riskFlags', en: 'Risk flags', ar: 'علامات الخطر', value: (o) => (o.riskFlags || []).join(', ') },
  { key: 'notes', en: 'Notes', ar: 'ملاحظات', value: (o) => o.notes },
  { key: 'confirmedAt', en: 'Confirmed at', ar: 'وقت التأكيد', value: (o, i, x) => x.date(o.confirmedAt) },
  { key: 'cancelledAt', en: 'Cancelled at', ar: 'وقت الإلغاء', value: (o, i, x) => x.date(o.cancelledAt) },
  { key: 'cancellationReason', en: 'Cancellation reason', ar: 'سبب الإلغاء', value: (o) => o.cancellationReason },
  // Per order line.
  { key: 'productName', en: 'Product', ar: 'المنتج', item: true, value: (o, i) => (i ? i.productNameSnapshot : '') },
  { key: 'variant', en: 'Variant', ar: 'الخيار', item: true, value: (o, i) => (i ? variantText(i.variantOptionsSnapshot) : '') },
  { key: 'sku', en: 'SKU', ar: 'SKU', item: true, value: (o, i) => (i ? i.skuSnapshot : '') },
  { key: 'quantity', en: 'Quantity', ar: 'الكمية', item: true, value: (o, i) => (i ? i.quantity : '') },
  { key: 'unitPrice', en: 'Unit price', ar: 'سعر القطعة', item: true, value: (o, i) => (i ? money(i.unitPriceAmount) : '') },
  { key: 'lineTotal', en: 'Line total', ar: 'إجمالي السطر', item: true, value: (o, i) => (i ? money(i.lineTotalAmount) : '') },
];

const COLUMN_KEYS = COLUMNS.map((c) => c.key);
const byKey = new Map(COLUMNS.map((c) => [c.key, c]));

const DEFAULT_ORDER_COLUMNS = [
  'orderNumber',
  'createdAt',
  'stage',
  'customerName',
  'phone',
  'region',
  'city',
  'address',
  'items',
  'itemsCount',
  'paymentMethod',
  'subtotal',
  'discount',
  'shipping',
  'total',
  'currency',
  'carrier',
  'waybillNumber',
  'notes',
];
const DEFAULT_ITEM_COLUMNS = [
  'orderNumber',
  'createdAt',
  'stage',
  'customerName',
  'phone',
  'region',
  'city',
  'productName',
  'variant',
  'sku',
  'quantity',
  'unitPrice',
  'lineTotal',
  'total',
  'currency',
];

/** The catalogue the dashboard's export dialog is drawn from. */
function columnCatalogue() {
  return {
    columns: COLUMNS.map(({ key, en, ar, item }) => ({ key, label: { en, ar }, perItem: Boolean(item) })),
    defaults: { order: DEFAULT_ORDER_COLUMNS, item: DEFAULT_ITEM_COLUMNS },
    maxOrders: MAX_ORDERS,
  };
}

/**
 * One CSV cell. A value that a spreadsheet would run as a formula (it starts
 * with = + - @, tab or carriage return) is prefixed with an apostrophe: a
 * customer can type anything into a name or an address, and the file is
 * opened in Excel by staff.
 */
function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const line = (values) => `${values.map(cell).join(',')}\r\n`;

/** The latest shipment of each order on the page that is not cancelled. */
async function shipmentsFor(workspaceId, orderIds) {
  if (orderIds.length === 0) return new Map();
  const rows = await db.Shipment.findAll({
    where: { workspaceId, orderId: orderIds },
    attributes: ['orderId', 'carrierCode', 'waybillNumber', 'trackingUrl', 'status', 'createdAt'],
    order: [['createdAt', 'ASC']],
  });
  const byOrder = new Map();
  for (const row of rows) {
    const current = byOrder.get(row.orderId);
    if (!current || row.status !== 'cancelled' || current.status === 'cancelled') byOrder.set(row.orderId, row);
  }
  return byOrder;
}

/**
 * A courier's own layout (exportPresets.js): its column titles in its order,
 * each one of the columns above or a fixed value the courier asks for.
 */
function layoutColumns(layout) {
  return layout.map((entry) => {
    const header = String(entry.header || '');
    // A checkout form field's answer ('field:custom_1'), as the order kept it (checkout/checkoutForm.js).
    if (typeof entry.key === 'string' && entry.key.startsWith('field:')) {
      const fieldKey = entry.key.slice(6);
      return { key: entry.key, en: header, ar: header, value: (o) => ((o.checkoutFields || []).find((a) => a && a.key === fieldKey) || {}).value || '' };
    }
    if (entry.key && byKey.has(entry.key)) {
      const column = byKey.get(entry.key);
      return { ...column, en: header, ar: header };
    }
    const fixed = entry.fixed === undefined || entry.fixed === null ? '' : String(entry.fixed);
    return { key: 'fixed', en: header, ar: header, value: () => fixed };
  });
}

function resolveColumns(requested, rowPer, layout) {
  if (Array.isArray(layout) && layout.length > 0) return layoutColumns(layout);
  const keys = requested && requested.length > 0 ? requested : rowPer === 'item' ? DEFAULT_ITEM_COLUMNS : DEFAULT_ORDER_COLUMNS;
  return keys.map((key) => byKey.get(key)).filter(Boolean);
}

/**
 * Yields the file a chunk at a time: the BOM and header first (the BOM is
 * what makes Excel read Arabic as UTF-8), then one chunk per page of orders.
 *
 * @param {string} workspaceId
 * @param {object} filters   the orders list query: q, from, to, stage, sort, the three states
 * @param {object} options   { columns: string[], rowPer: 'order' | 'item', lang: 'en' | 'ar', timezone, maskPhones }
 *
 * `maskPhones`: every phone written partly hidden (010****665), as the orders
 * list shows them to a teammate without customers.reveal_sensitive (SPEC §3.4 #8).
 */
/** The order as written to the file: phones masked when the teammate may not see them. */
function phoneShape(maskPhones) {
  return maskPhones ? require('../../core/utils/phoneMask').maskPhonesDeep : (row) => row;
}

async function* csvChunks(workspaceId, filters, { columns: requested, rowPer = 'order', lang = 'en', timezone, maskPhones = false, layout } = {}) {
  const columns = resolveColumns(requested, rowPer, layout);
  const shape = phoneShape(maskPhones);
  const x = exportContext({ lang, timezone });
  yield `﻿${line(columns.map((c) => (lang === 'ar' ? c.ar : c.en)))}`;

  const query = { ...filters, limit: PAGE_SIZE };
  delete query.cursor;
  let exported = 0;
  let cursor;
  do {
    const page = await orderService.listOrders(workspaceId, { ...query, cursor });
    const shipments = await shipmentsFor(
      workspaceId,
      page.orders.map((o) => o.id)
    );
    let chunk = '';
    for (const order of page.orders) {
      const row = shape({ ...order, shipment: shipments.get(order.id) || null });
      const items = rowPer === 'item' && row.items && row.items.length > 0 ? row.items : [null];
      for (const item of items) chunk += line(columns.map((c) => c.value(row, item, x)));
    }
    exported += page.orders.length;
    if (chunk) yield chunk;
    cursor = page.nextCursor;
  } while (cursor && exported < MAX_ORDERS);

  if (cursor) yield line([`Stopped at ${MAX_ORDERS} orders — narrow the date range to export the rest.`]);
}

// Columns that are amounts or counts: numeric cells in a spreadsheet, so they
// can be summed. Everything else stays text (a phone keeps its leading zero).
const NUMERIC_COLUMNS = new Set([
  'subtotal',
  'discount',
  'shipping',
  'tax',
  'total',
  'codAmount',
  'amountPaid',
  'amountRefunded',
  'itemsCount',
  'quantity',
  'unitPrice',
  'lineTotal',
]);

/**
 * The same table as csvChunks, as rows of cells (header first), for the xlsx
 * format. Built in memory: the spreadsheet is one zipped document, so there
 * is nothing to stream; MAX_ORDERS bounds it as it bounds the CSV.
 */
async function tableRows(workspaceId, filters, { columns: requested, rowPer = 'order', lang = 'en', timezone, maskPhones = false, layout } = {}) {
  const columns = resolveColumns(requested, rowPer, layout);
  const shape = phoneShape(maskPhones);
  const x = exportContext({ lang, timezone });
  const rows = [columns.map((c) => (lang === 'ar' ? c.ar : c.en))];
  const asCell = (column, value) => {
    if (value === null || value === undefined) return '';
    if (NUMERIC_COLUMNS.has(column.key) && /^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
    return String(value);
  };

  const query = { ...filters, limit: PAGE_SIZE };
  delete query.cursor;
  let exported = 0;
  let cursor;
  do {
    const page = await orderService.listOrders(workspaceId, { ...query, cursor });
    const shipments = await shipmentsFor(
      workspaceId,
      page.orders.map((o) => o.id)
    );
    for (const order of page.orders) {
      const row = shape({ ...order, shipment: shipments.get(order.id) || null });
      const items = rowPer === 'item' && row.items && row.items.length > 0 ? row.items : [null];
      for (const item of items) rows.push(columns.map((c) => asCell(c, c.value(row, item, x))));
    }
    exported += page.orders.length;
    cursor = page.nextCursor;
  } while (cursor && exported < MAX_ORDERS);
  if (cursor) rows.push([`Stopped at ${MAX_ORDERS} orders — narrow the date range to export the rest.`]);
  return rows;
}

/**
 * One order as rows of cells in a layout — what the Google Sheets sync writes
 * (modules/sheets): the same columns and words as the export, numbers as
 * numbers. `order` is shaped as the list shows it (with `stage` and its
 * latest `shipment`).
 */
function rowsForOrder(order, { layout, rowPer = 'order', lang = 'en', timezone, maskPhones = false } = {}) {
  const columns = resolveColumns(undefined, rowPer, layout);
  const x = exportContext({ lang, timezone });
  const row = phoneShape(maskPhones)(order);
  const asCell = (column, value) => {
    if (value === null || value === undefined) return '';
    if (NUMERIC_COLUMNS.has(column.key) && /^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
    return String(value);
  };
  const items = rowPer === 'item' && row.items && row.items.length > 0 ? row.items : [null];
  return items.map((item) => columns.map((c) => asCell(c, c.value(row, item, x))));
}

module.exports = { csvChunks, tableRows, rowsForOrder, columnCatalogue, COLUMN_KEYS, MAX_ORDERS };
