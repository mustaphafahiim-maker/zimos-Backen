'use strict';

/** Customer referrals (index.js): reward the referrer on delivery, void the invite on cancel or return. */
// eslint-disable-next-line global-require
const svc = () => require('./index');

module.exports = {
  consumers: [
    { name: 'customer_referral_reward', queue: 'default', events: ['order.delivered'], handle: (event) => svc().onDelivered(event) },
    { name: 'customer_referral_cancelled', queue: 'default', events: ['order.cancelled'], handle: (event) => svc().onVoided(event, 'cancelled') },
    { name: 'customer_referral_returned', queue: 'default', events: ['order.returned'], handle: (event) => svc().onVoided(event, 'returned') },
  ],
};
