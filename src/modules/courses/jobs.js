'use strict';

module.exports = {
  consumers: [
    {
      // A paid order enrols its buyer in the courses sold through its products (SPEC §3.2: through the outbox, retried).
      name: 'courses_enroll',
      queue: 'default',
      events: ['order.paid'],
      // eslint-disable-next-line global-require
      handle: (event) => require('./courseService').enrollForOrder(event.workspaceId, event.payload.orderId, { rethrow: true }),
    },
  ],
};
