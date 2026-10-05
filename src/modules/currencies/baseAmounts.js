'use strict';

/**
 * An order's amounts in the store's own currency, for the reports that add
 * orders up (analytics, profit). An order is priced in the store's currency
 * and no exchange rate is recorded on it, so every amount is already its base
 * amount: the factor is 1. The SQL helpers take a table alias (default 'o').
 */

const factorSql = () => '1';

const totalSql = (a = 'o') => `${a}.total_amount`;

const amountSql = (column, a = 'o') => `${a}.${column}`;

const factor = () => 1;

const total = (order) => Number(order.totalAmount);

const amount = (order, value) => Math.round(Number(value || 0));

const ATTRIBUTES = ['totalAmount'];

module.exports = { factorSql, totalSql, amountSql, factor, total, amount, ATTRIBUTES };
