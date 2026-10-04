'use strict';

/**
 * What scripts/launch-reset.js does with every table, one entry per table.
 * tests/integration/launchReset.test.js fails while the database holds a table
 * that is not listed here (or this lists one the database does not have), so a
 * new migration's table has to be classified before the reset can run.
 *
 *   keep          every row stays exactly as it is
 *   keep-creator  only the creator's row stays (users: platform_role = 'creator',
 *                 exactly one); every other row is deleted
 *   wipe          every row is deleted (DELETE, children before parents)
 *   truncate      every row is deleted with TRUNCATE ... RESTRICT, before the
 *                 deletes (the wallet ledger refuses DELETE on its rows)
 *   decide        not clear which: kept as it is until it is moved to one of the
 *                 above, and --apply refuses while any table is still here
 *                 ({ action: 'decide', why }); none is left today
 */

const keep = (why) => ({ action: 'keep', why });
const wipe = (why) => ({ action: 'wipe', why });

const STORE = 'belongs to a store (workspace_id NOT NULL)';

const TABLES = {
  // ---- kept --------------------------------------------------------------
  SequelizeMeta: keep('which migrations have run'),
  plans: keep('the plans and their prices'),
  templates: keep('the store templates'),
  template_versions: keep('the store templates (each version)'),
  payment_methods: keep('how merchants pay the platform (with the account numbers)'),
  feature_flags: keep('the platform flags; target_workspace_ids keeps ids of stores that are gone'),
  platform_roles: keep('the console role definitions (creator, admin, agent); no row points at a user, users.platform_role points here'),
  users: { action: 'keep-creator', why: 'the creator account only; every other account goes' },

  // ---- wallet ledger: TRUNCATE ------------------------------------------
  wallet_ledger_entries: { action: 'truncate', why: 'the prepaid balance ledger; its trigger refuses DELETE on a row of a store that still exists' },
  workspace_wallets: { action: 'truncate', why: 'the prepaid balances, emptied with their ledger' },

  // ---- wiped -------------------------------------------------------------
  agent_commissions: wipe('commissions of agents (accounts that go) on store invoices'),
  analytics_events: wipe(STORE),
  analytics_sessions: wipe(STORE),
  announcements: wipe('announcements written in the console before launch (decided: wipe)'),
  api_keys: wipe(STORE),
  audit_logs: wipe('the audit log'),
  automation_rules: wipe(STORE),
  billing_gateway_events: wipe('payment gateway webhooks for store invoices'),
  billing_invoices: wipe('subscription invoices of stores'),
  billing_payment_attempts: wipe('online payments of store invoices'),
  carrier_accounts: wipe("a store's courier connection; the courier list itself is in code and the environment"),
  cart_items: wipe('store carts (each line)'),
  carts: wipe(STORE),
  checkout_sessions: wipe(STORE),
  collections: wipe(STORE),
  confirmation_attempts: wipe('order confirmation calls'),
  confirmation_tasks: wipe(STORE),
  credit_notes: wipe(STORE),
  customer_addresses: wipe(STORE),
  customer_uploads: wipe(STORE),
  customers: wipe(STORE),
  discount_redemptions: wipe(STORE),
  discounts: wipe(STORE),
  domains: wipe(STORE),
  experiment_assignments: wipe('store experiments'),
  experiments: wipe(STORE),
  funnel_creations: wipe(STORE),
  funnel_edges: wipe(STORE),
  funnel_offer_acceptances: wipe(STORE),
  funnel_revisions: wipe(STORE),
  funnel_sessions: wipe(STORE),
  funnel_steps: wipe(STORE),
  funnels: wipe(STORE),
  idempotency_keys: wipe(STORE),
  inventory_movements: wipe(STORE),
  invoice_counters: wipe(STORE),
  invoices: wipe(STORE),
  media_assets: wipe(STORE),
  memberships: wipe('who works in which store'),
  notification_logs: wipe('sent notifications'),
  offer_variants: wipe('store offers'),
  offers: wipe(STORE),
  order_items: wipe('store orders'),
  orders: wipe(STORE),
  otp_codes: wipe('SMS codes'),
  payment_events: wipe(STORE),
  payment_gateway_accounts: wipe("a store's payment gateway connection; the gateway list itself is in code and the environment"),
  payment_proofs: wipe('transfer proofs sent by stores'),
  payments: wipe(STORE),
  plan_trials: wipe('which plan trials each account has used, the creator\'s included (decided: wipe)'),
  platform_blocklist_entries: wipe('the platform-wide risk blocklist from before launch (decided: wipe)'),
  product_collections: wipe('store products'),
  product_variants: wipe(STORE),
  products: wipe(STORE),
  referral_codes: wipe('referral codes of agents (accounts that go; agent_id is NOT NULL, ON DELETE RESTRICT) (decided: wipe)'),
  refunds: wipe(STORE),
  return_requests: wipe(STORE),
  reviews: wipe(STORE),
  roles: wipe("a store's own roles, not the console roles"),
  sessions: wipe('sign-in sessions and refresh tokens, the creator\'s included'),
  shipments: wipe(STORE),
  shipping_rates: wipe(STORE),
  shipping_weight_tiers: wipe(STORE),
  shipping_zone_tier_prices: wipe(STORE),
  shipping_zones: wipe(STORE),
  subscription_manual_changes: wipe('store subscriptions'),
  subscription_terms: wipe('store subscriptions'),
  subscriptions: wipe(STORE),
  support_ticket_messages: wipe('support tickets'),
  support_tickets: wipe('support tickets'),
  tax_rates: wipe(STORE),
  verification_codes: wipe('sign-up and account-change codes (email and SMS), the creator\'s included'),
  verification_tokens: wipe('email and password-reset links, the creator\'s included'),
  webhook_deliveries: wipe(STORE),
  webhook_endpoints: wipe(STORE),
  website_page_redirects: wipe(STORE),
  website_pages: wipe(STORE),
  website_revisions: wipe(STORE),
  websites: wipe(STORE),
  workspace_feature_overrides: wipe(STORE),
  workspaces: wipe("every store, the creator's included"),
};

const ACTIONS = ['keep', 'keep-creator', 'wipe', 'truncate', 'decide'];

module.exports = { TABLES, ACTIONS };
