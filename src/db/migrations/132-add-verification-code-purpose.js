'use strict';

/**
 * What a 6-digit code is for (otp/verificationCodeService). Until now every
 * code confirmed a new account; changing an account's email or phone needs
 * codes of its own, which must neither satisfy nor count against the
 * sign-up ones:
 *
 *   signup        confirming the account (every existing row)
 *   reauth        proving it is the owner, for an account with no password
 *                 (made through Google), before changing its email or phone
 *   email_change  sent to the new email; confirming it makes the change
 *   phone_change  sent by SMS to the new number (PHONE_CHANGE_ENABLED)
 *
 * The column has a constant default, so adding it rewrites nothing. The check
 * is added NOT VALID and validated afterwards, which reads the table without
 * blocking writes to it. Harmless if it runs again (IF NOT EXISTS, the check
 * dropped before it is added). Down first retires every live code of the new
 * kinds, so that without the column none can pass for a sign-up code.
 */

const PURPOSES = ['signup', 'reauth', 'email_change', 'phone_change'];

module.exports = {
  up: async (queryInterface) => {
    const run = (sql, options) => queryInterface.sequelize.query(sql, options);
    await queryInterface.sequelize.transaction(async (transaction) => {
      await run("ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) NOT NULL DEFAULT 'signup'", { transaction });
      await run('ALTER TABLE verification_codes DROP CONSTRAINT IF EXISTS verification_codes_purpose_check', { transaction });
      await run(
        `ALTER TABLE verification_codes ADD CONSTRAINT verification_codes_purpose_check
           CHECK (purpose IN (${PURPOSES.map((p) => `'${p}'`).join(', ')})) NOT VALID`,
        { transaction }
      );
    });
    await run('ALTER TABLE verification_codes VALIDATE CONSTRAINT verification_codes_purpose_check');
  },

  down: async (queryInterface) => {
    await queryInterface.sequelize.transaction(async (transaction) => {
      const run = (sql) => queryInterface.sequelize.query(sql, { transaction });
      const exists = await queryInterface.sequelize.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'verification_codes' AND column_name = 'purpose'",
        { transaction, type: queryInterface.sequelize.QueryTypes.SELECT }
      );
      if (exists.length > 0) {
        await run(
          "UPDATE verification_codes SET superseded_at = NOW() WHERE purpose <> 'signup' AND consumed_at IS NULL AND superseded_at IS NULL"
        );
      }
      await run('ALTER TABLE verification_codes DROP CONSTRAINT IF EXISTS verification_codes_purpose_check');
      await run('ALTER TABLE verification_codes DROP COLUMN IF EXISTS purpose');
    });
  },
};
