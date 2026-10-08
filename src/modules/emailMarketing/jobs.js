'use strict';

/**
 * Contacts to Mailchimp / Klaviyo in the background (emailMarketing.js): a new
 * or changed contact goes to every connected list; "Sync now" is an io job.
 */
// eslint-disable-next-line global-require
const svc = () => require('./emailMarketing');

module.exports = {
  consumers: [
    {
      name: 'email_marketing_contacts',
      queue: 'default',
      events: ['lead.created', 'customer.created', 'contact.updated', 'contact.erased'],
      handle: (event) => svc().onContactEvent(event),
    },
  ],
  // The provider upserts contacts: a sync cut off by a restart is run again.
  processors: [{ queue: 'io', name: 'email_marketing.backfill', handle: (job) => svc().backfill(job), resumable: true, onInterrupted: (job) => svc().backfillInterrupted(job) }],
};
