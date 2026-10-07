'use strict';

/**
 * `domains.renew_due` (item 176): once a day, domains bought in the dashboard
 * with auto-renew on are renewed in their last 30 days (purchases.js). It runs
 * whatever CUSTOM_DOMAINS_ENABLED says: a bought domain is never left to lapse.
 *
 * Item 341 (Ziad's 045801f, domainJobs.js): certificates still pending (every
 * 5 minutes, failed 72 hours after the request), issued ones checked for
 * `moved` (daily), provider deletions that failed (every 15 minutes), pending
 * rows past CUSTOM_DOMAINS_PENDING_TTL_DAYS (hourly, only when it is set), and
 * domains of suspended stores or of plans without custom_domain (every 10
 * minutes). Each does nothing while CUSTOM_DOMAINS_ENABLED closes custom
 * domains, except the deletion retry.
 */
const MINUTE = 60 * 1000;
// eslint-disable-next-line global-require
const jobs = () => require('./domainJobs');

module.exports = {
  schedules: [
    {
      name: 'domains.renew_due',
      everyMs: 24 * 60 * MINUTE,
      // eslint-disable-next-line global-require
      handle: () => require('./purchases').renewDue(),
    },
    { name: 'domains.poll_certificates', everyMs: 5 * MINUTE, handle: () => jobs().pollPendingCertificates() },
    { name: 'domains.check_active_certificates', everyMs: 24 * 60 * MINUTE, handle: () => jobs().checkActiveCertificates() },
    { name: 'domains.retry_provider_deletions', everyMs: 15 * MINUTE, handle: () => jobs().retryProviderDeletions() },
    { name: 'domains.remove_expired_pending', everyMs: 60 * MINUTE, handle: () => jobs().removeExpiredPending() },
    { name: 'domains.enforce_access', everyMs: 10 * MINUTE, handle: () => jobs().enforceAccess() },
  ],
};
