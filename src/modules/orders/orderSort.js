'use strict';

/**
 * How the merchant lists may be sorted: a whitelist. The client names a key,
 * never a column, and anything else is refused by validation (or falls back
 * to the default here).
 *
 * Every sort is a keyset: (sort column, id) in one direction, `id` breaking
 * ties so the order is total and a cursor pages through it without skipping
 * or repeating rows while orders arrive. The orders list pages on the order's
 * id, the confirmation queue on the task's id — the caller names the column.
 *
 *   newest      placed, newest first   (the orders list's default)
 *   oldest      placed, oldest first
 *   total_desc  order total, high to low
 *   total_asc   order total, low to high
 *
 * The confirmation queue also takes `default`: each tab's own order, as it
 * has always been (see confirmationService TABS).
 */
const ORDER_SORTS = Object.freeze({
  newest: { column: 'o.created_at', cast: 'timestamptz', direction: 'DESC', anchor: 'createdAt' },
  oldest: { column: 'o.created_at', cast: 'timestamptz', direction: 'ASC', anchor: 'createdAt' },
  total_desc: { column: 'o.total_amount', cast: 'bigint', direction: 'DESC', anchor: 'totalAmount' },
  total_asc: { column: 'o.total_amount', cast: 'bigint', direction: 'ASC', anchor: 'totalAmount' },
});

const ORDER_SORT_KEYS = Object.freeze(Object.keys(ORDER_SORTS));
const DEFAULT_ORDER_SORT = 'newest';

const QUEUE_DEFAULT_SORT = 'default';
const QUEUE_SORT_KEYS = Object.freeze([QUEUE_DEFAULT_SORT, ...ORDER_SORT_KEYS]);

/** The sort for a key; an unknown key gets the default, never a raw column. */
function orderSort(key) {
  const resolved = Object.prototype.hasOwnProperty.call(ORDER_SORTS, key) ? key : DEFAULT_ORDER_SORT;
  return { key: resolved, ...ORDER_SORTS[resolved] };
}

/** `ORDER BY` body: the sort column, then `idColumn`, both in the sort's direction. */
function orderByClause(sort, idColumn) {
  return `${sort.column} ${sort.direction}, ${idColumn} ${sort.direction}`;
}

/**
 * The keyset condition: rows strictly after the anchor row in this sort.
 * `valueParam` / `idParam` are bind parameter names (without the `$`).
 */
function afterAnchorClause(sort, idColumn, valueParam, idParam) {
  const comparison = sort.direction === 'DESC' ? '<' : '>';
  return `(${sort.column}, ${idColumn}) ${comparison} ($${valueParam}::${sort.cast}, $${idParam}::uuid)`;
}

/** The anchor order's value for this sort, as a bind parameter. */
function anchorValue(sort, order) {
  const value = order[sort.anchor];
  return value instanceof Date ? value.toISOString() : String(value);
}

module.exports = {
  ORDER_SORT_KEYS,
  DEFAULT_ORDER_SORT,
  QUEUE_SORT_KEYS,
  QUEUE_DEFAULT_SORT,
  orderSort,
  orderByClause,
  afterAnchorClause,
  anchorValue,
};
