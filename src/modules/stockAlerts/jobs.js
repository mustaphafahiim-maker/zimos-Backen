'use strict';

/** Back-in-stock alerts (index.js): the hook is installed when this loads; the consumer tells the waiting shoppers. */
// eslint-disable-next-line global-require
const svc = () => require('./index');
svc().install();

module.exports = {
  consumers: [{ name: 'stock_alerts_notify', queue: 'notifications', events: ['variant.back_in_stock'], handle: (event) => svc().notify(event) }],
};
