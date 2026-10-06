'use strict';

/**
 * Google Sheets in the background (sheetSync.js): every new or changed order,
 * lost order and sign-up is written to the store's connected sheets, and "Sync
 * existing" fills a sheet with the last 30 days. Consumers retry on a thrown
 * error (the outbox's backoff); the backfill is an io job, run once.
 */
// eslint-disable-next-line global-require
const sync = () => require('./sheetSync');

module.exports = {
  consumers: [
    {
      name: 'sheets_orders',
      queue: 'default',
      events: ['order.created', ...require('./sheetSync').ORDER_UPDATE_EVENTS],
      handle: (event) => sync().onOrderEvent(event),
    },
    {
      name: 'sheets_lost_orders',
      queue: 'default',
      events: [...require('./sheetSync').LOST_NEW_EVENTS, 'checkout.recovered'],
      handle: (event) => sync().onLostOrderEvent(event),
    },
    {
      name: 'sheets_leads',
      queue: 'default',
      events: ['contact_form.submitted'],
      handle: (event) => sync().onLeadEvent(event),
    },
  ],
  processors: [
    {
      queue: 'io',
      name: 'sheets.backfill',
      handle: (job) => sync().backfill(job),
    },
  ],
};
