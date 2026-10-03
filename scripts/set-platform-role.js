'use strict';

/**
 * Gives one account a platform-console role, with that role's default
 * permission set (platform_roles.default_permissions).
 *
 *   node scripts/set-platform-role.js ziadabbas27@gmail.com creator
 *   node scripts/set-platform-role.js someone@example.com none     # revoke
 *
 * This is the out-of-band way in: the API only lets a creator make another
 * creator, so the first one — on a fresh database, or one where migration
 * 105 found no account to promote — has to be made here. It replaces
 * scripts/grant-platform-admin.js, whose users.platform_admin flag is no
 * longer read.
 *
 * Runs against whatever database src/config/env resolves (DATABASE_URL, else
 * the DB_* vars in .env), so check which one that is before running it in an
 * environment that matters. It writes no audit row (there is no acting user);
 * re-running it with the same role is a no-op.
 */

const db = require('../src/db/models');

async function main() {
  const email = (process.argv[2] || '').trim();
  const roleKey = (process.argv[3] || '').trim();
  if (!email || !roleKey) {
    console.error('Usage: node scripts/set-platform-role.js <email> <role|none>');
    process.exitCode = 1;
    return;
  }

  // users.email is CITEXT, so this ignores case.
  const user = await db.User.findOne({ where: { email } });
  if (!user) {
    console.error(`No account with email "${email}".`);
    process.exitCode = 1;
    return;
  }

  if (roleKey === 'none') {
    await user.update({ platformRole: null, platformPermissions: [] });
    console.log(`${user.email} no longer has platform-console access.`);
    return;
  }

  const role = await db.PlatformRole.findByPk(roleKey);
  if (!role) {
    const known = await db.PlatformRole.findAll({ attributes: ['key'], order: [['key', 'ASC']] });
    console.error(`Unknown role "${roleKey}". Known roles: ${known.map((r) => r.key).join(', ')}, or "none".`);
    process.exitCode = 1;
    return;
  }

  if (user.platformRole === role.key) {
    console.log(`${user.email} already has the ${role.key} role — nothing to do.`);
    return;
  }

  await user.update({ platformRole: role.key, platformPermissions: role.defaultPermissions });
  console.log(`${user.email} now has the ${role.key} role.`);

  // `authenticate` rejects anything that is not active, so the role alone is
  // not enough to actually reach /admin/*.
  if (user.status !== 'active') {
    console.log(`Warning: status is "${user.status}" — it must be "active" to authenticate.`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.sequelize.close());
