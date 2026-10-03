'use strict';

const crypto = require('crypto');

/**
 * How a merchant can pay Zimos (billing/paymentMethodService), and the proofs
 * of a manual transfer they send in (billing/paymentProofService).
 *
 * payment_methods: one row per way to pay, shown to merchants only while
 * `enabled` (and, for a gateway, while its adapter is configured from the
 * environment — billing/gateways). Never a secret or a gateway key: those
 * live in the environment only. For a manual method, `account_number` is
 * where the merchant sends the money (an InstaPay address or a wallet
 * number) and `note_ar` / `note_en` how; a manual method cannot be enabled
 * without its number. Seeded with InstaPay and a mobile wallet, both off.
 *
 * payment_proofs: a merchant's "I sent it" for a manual method, with the
 * screenshot, waiting for a platform admin to check the money arrived:
 *
 *   purpose           'invoice' (a subscription charge)
 *   requested_amount  what the merchant must send, priced by the server when
 *                     the proof is sent (the charge's amount payable then,
 *                     frozen with its discount and code, as an online
 *                     checkout freezes it)
 *   received_amount   what the reviewer saw arrive, entered at approval
 *   status            pending | approved | rejected (a rejection needs a note)
 *   image_*           the screenshot, stored privately, never public; its
 *                     SHA-256 is unique, so one image is never sent twice
 *
 * One pending proof per charge (a partial unique index). The number the
 * money was sent to is copied onto the proof, so a later change of the
 * method's number doesn't change what the reviewer checks against.
 *
 * Runs once per database (SequelizeMeta); written to be harmless if it ever
 * runs again: IF NOT EXISTS everywhere, the seed rows ON CONFLICT DO NOTHING.
 */

const SEED = [
  { code: 'instapay', labelAr: 'إنستا باي', labelEn: 'InstaPay', sortOrder: 10 },
  { code: 'wallet', labelAr: 'محفظة إلكترونية', labelEn: 'Mobile wallet', sortOrder: 20 },
];

module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql, replacements) => queryInterface.sequelize.query(sql, { transaction, replacements });

      await run(`
        CREATE TABLE IF NOT EXISTS payment_methods (
          id UUID PRIMARY KEY,
          kind VARCHAR(10) NOT NULL CONSTRAINT payment_methods_kind_check CHECK (kind IN ('manual', 'gateway')),
          code VARCHAR(40) NOT NULL CONSTRAINT payment_methods_code_key UNIQUE
            CONSTRAINT payment_methods_code_check CHECK (code ~ '^[a-z][a-z0-9_]{1,39}$'),
          label_ar VARCHAR(80) NOT NULL,
          label_en VARCHAR(80) NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          enabled BOOLEAN NOT NULL DEFAULT FALSE,
          account_number VARCHAR(80),
          note_ar VARCHAR(500),
          note_en VARCHAR(500),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT payment_methods_manual_fields_check
            CHECK (kind = 'manual' OR (account_number IS NULL AND note_ar IS NULL AND note_en IS NULL)),
          CONSTRAINT payment_methods_manual_number_check
            CHECK (kind <> 'manual' OR NOT enabled OR account_number IS NOT NULL)
        )`);

      for (const row of SEED) {
        await run(
          `INSERT INTO payment_methods (id, kind, code, label_ar, label_en, sort_order, enabled)
           VALUES (:id, 'manual', :code, :labelAr, :labelEn, :sortOrder, FALSE)
           ON CONFLICT (code) DO NOTHING`,
          { id: crypto.randomUUID(), ...row }
        );
      }

      await run(`
        CREATE TABLE IF NOT EXISTS payment_proofs (
          id UUID PRIMARY KEY,
          workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE ON UPDATE CASCADE,
          purpose VARCHAR(20) NOT NULL CONSTRAINT payment_proofs_purpose_check CHECK (purpose IN ('invoice')),
          billing_invoice_id UUID REFERENCES billing_invoices (id) ON DELETE CASCADE ON UPDATE CASCADE,
          payment_method_id UUID NOT NULL REFERENCES payment_methods (id) ON DELETE RESTRICT ON UPDATE CASCADE,
          method_code VARCHAR(40) NOT NULL,
          receiving_number VARCHAR(80) NOT NULL,
          sender_phone VARCHAR(20) NOT NULL,
          currency CHAR(3) NOT NULL CONSTRAINT payment_proofs_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
          requested_amount BIGINT NOT NULL CONSTRAINT payment_proofs_requested_check CHECK (requested_amount > 0),
          gross_amount BIGINT,
          discount_amount BIGINT,
          referral_code_id UUID REFERENCES referral_codes (id) ON DELETE SET NULL ON UPDATE CASCADE,
          received_amount BIGINT CONSTRAINT payment_proofs_received_check CHECK (received_amount IS NULL OR received_amount >= 0),
          status VARCHAR(10) NOT NULL DEFAULT 'pending'
            CONSTRAINT payment_proofs_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
          review_note VARCHAR(1000),
          reviewed_by_user_id UUID REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
          reviewed_at TIMESTAMPTZ,
          submitted_by_user_id UUID REFERENCES users (id) ON DELETE SET NULL ON UPDATE CASCADE,
          image_key VARCHAR(255) NOT NULL,
          image_mime VARCHAR(30) NOT NULL,
          image_bytes INTEGER NOT NULL,
          image_sha256 CHAR(64) NOT NULL CONSTRAINT payment_proofs_image_sha256_key UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT payment_proofs_invoice_check CHECK (purpose <> 'invoice' OR billing_invoice_id IS NOT NULL),
          CONSTRAINT payment_proofs_approved_check CHECK (status <> 'approved' OR received_amount IS NOT NULL),
          CONSTRAINT payment_proofs_rejected_check CHECK (status <> 'rejected' OR review_note IS NOT NULL)
        )`);

      await run(`CREATE UNIQUE INDEX IF NOT EXISTS payment_proofs_one_pending_per_invoice_idx
                   ON payment_proofs (billing_invoice_id) WHERE status = 'pending'`);
      await run('CREATE INDEX IF NOT EXISTS payment_proofs_workspace_idx ON payment_proofs (workspace_id, created_at)');
      await run('CREATE INDEX IF NOT EXISTS payment_proofs_queue_idx ON payment_proofs (status, created_at)');
    });
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.sequelize.query('DROP TABLE IF EXISTS payment_proofs', { transaction });
      await queryInterface.sequelize.query('DROP TABLE IF EXISTS payment_methods', { transaction });
    });
  },
};
