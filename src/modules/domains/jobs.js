'use strict';

/**
 * Custom domains (domainJobs.js): certificates still pending (every 5
 * minutes, failed after 72 hours), issued ones checked for `moved` (daily),
 * provider deletions that failed (every 15 minutes), pending rows past their
 * 7 days (hourly), domains of suspended stores or of plans without
 * custom_domain (every 10 minutes), and hostnames at Cloudflare no domain row
 * knows (daily). Each does nothing while CUSTOM_DOMAINS_ENABLED is off, except
 * the deletion retry.
 */
const MINUTE = 60 * 1000;
// eslint-disable-next-line global-require
const jobs = () => require('./domainJobs');

module.exports = {
  schedules: [
    { name: 'domains.poll_certificates', everyMs: 5 * MINUTE, handle: () => jobs().pollPendingCertificates() },
    { name: 'domains.check_active_certificates', everyMs: 24 * 60 * MINUTE, handle: () => jobs().checkActiveCertificates() },
    { name: 'domains.retry_provider_deletions', everyMs: 15 * MINUTE, handle: () => jobs().retryProviderDeletions() },
    { name: 'domains.remove_expired_pending', everyMs: 60 * MINUTE, handle: () => jobs().removeExpiredPending() },
    { name: 'domains.enforce_access', everyMs: 10 * MINUTE, handle: () => jobs().enforceAccess() },
    { name: 'domains.reconcile_provider_hostnames', everyMs: 24 * 60 * MINUTE, handle: () => jobs().reconcileProviderHostnames() },
  ],
};
