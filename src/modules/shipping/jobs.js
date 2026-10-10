'use strict';

const MINUTE = 60 * 1000;

module.exports = {
  consumers: [
    {
      // Book with the store's automatic courier once an order is confirmed or
      // paid (carrierBooking.js). Never retried: a courier create is not undoable.
      name: 'carrier_auto_booking',
      queue: 'carriers',
      events: ['order.confirmed', 'order.paid'],
      // eslint-disable-next-line global-require
      handle: (event) => require('./carrierBooking').autoBook(event),
      // Cut off by a restart, it is never run again (the courier may have
      // booked the parcel): the merchant is told to check (core/queue).
      once: true,
      // eslint-disable-next-line global-require
      onInterrupted: (event) => require('./carrierBooking').autoBookInterrupted(event),
    },
  ],
  processors: [
    {
      // "Ship selected": books a batch's orders one by one (bulkShipping.js).
      // Each booking is guarded against repeating; a crashed run is resumed
      // with the order it was booking marked interrupted, never booked again.
      queue: 'carriers',
      name: 'shipments.bulk_book',
      // eslint-disable-next-line global-require
      handle: (job) => require('./bulkShipping').processBatch(job),
    },
  ],
  schedules: [
    {
      // Couriers without a webhook are asked for their shipments' status
      // (what scripts/sync-carrier-shipments.js does from a cron).
      name: 'carriers.poll_status',
      everyMs: 30 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./carrierSyncService').syncDue(),
    },
  ],
};
