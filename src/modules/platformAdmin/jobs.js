'use strict';

const HOUR = 60 * 60 * 1000;

module.exports = {
  schedules: [
    {
      // Console notifications for subscriptions ending within 7 days or just
      // ended (platformNotificationService.sweepSubscriptions).
      name: 'platform_notifications.subscription_sweep',
      everyMs: HOUR,
      // eslint-disable-next-line global-require
      handle: () => require('./platformNotificationService').sweepSubscriptions(),
    },
  ],
};
