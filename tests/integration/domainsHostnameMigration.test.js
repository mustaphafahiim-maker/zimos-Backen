'use strict';

// Migration 211: hostname unique only among verified/active rows, and a down()
// that brings the old uniqueness back even when several rows share a host.
const Sequelize = require('sequelize');
const { app, request, registerAndActivate, createWorkspace } = require('../helpers/factories');
const db = require('../../src/db/models');
const migration = require('../../src/db/migrations/211-domains-hostname-unique-when-verified');

const qi = () => db.sequelize.getQueryInterface();

async function indexNames() {
  const [rows] = await db.sequelize.query("SELECT indexname FROM pg_indexes WHERE tablename = 'domains'");
  return rows.map((r) => r.indexname).sort();
}

async function storeWithWebsite(name) {
  const auth = await registerAndActivate();
  const workspace = await createWorkspace(auth.accessToken, name);
  await request(app)
    .post(`/api/v1/workspaces/${workspace.id}/quickstart`)
    .set({ Authorization: `Bearer ${auth.accessToken}` })
    .type('form')
    .send({ productName: 'Widget', price: '10.00' });
  const website = await db.Website.findOne({ where: { workspaceId: workspace.id } });
  return { workspaceId: workspace.id, websiteId: website.id };
}

const row = (store, hostname, status, token) =>
  db.Domain.create({ ...store, hostname, status, verificationToken: token });

it('up: several unverified rows may share a host, two verified rows may not; running it twice is fine', async () => {
  await migration.up(qi(), Sequelize);
  expect(await indexNames()).toEqual(
    expect.arrayContaining(['domains_hostname_lookup_idx', 'domains_hostname_verified_unique'])
  );
  expect(await indexNames()).not.toContain('domains_hostname_idx');
  expect(await indexNames()).not.toContain('domains_hostname_key');

  const a = await storeWithWebsite('Mig A');
  const b = await storeWithWebsite('Mig B');
  await row(a, 'www.shared.com', 'pending_verification', 'a1');
  await row(b, 'www.shared.com', 'verified', 'b1');
  await expect(row(a, 'www.shared.com', 'active', 'a2')).rejects.toThrow();
});

it('down: keeps the verified row, removes the extra unverified ones, and restores the old uniqueness; twice is fine', async () => {
  const a = await storeWithWebsite('Down A');
  const b = await storeWithWebsite('Down B');
  const c = await storeWithWebsite('Down C');
  const squat = await row(a, 'www.taken.com', 'pending_verification', 't1');
  const owner = await row(b, 'www.taken.com', 'verified', 't2');
  const first = await row(a, 'www.open.com', 'pending_verification', 'o1');
  const later = await row(c, 'www.open.com', 'pending_verification', 'o2');
  await db.sequelize.query("UPDATE domains SET created_at = now() + interval '1 minute' WHERE id = $1", { bind: [later.id] });

  try {
    await migration.down(qi(), Sequelize);
    await migration.down(qi(), Sequelize);
  } catch (err) {
    // Leave the schema as the rest of the suite expects it.
    await migration.up(qi(), Sequelize);
    throw err;
  }

  expect(await db.Domain.findByPk(squat.id)).toBeNull();
  expect(await db.Domain.findByPk(owner.id)).not.toBeNull();
  expect(await db.Domain.findByPk(first.id)).not.toBeNull();
  expect(await db.Domain.findByPk(later.id)).toBeNull();
  expect(await indexNames()).toEqual(expect.arrayContaining(['domains_hostname_idx', 'domains_hostname_key']));
  expect(await indexNames()).not.toContain('domains_hostname_verified_unique');
  const refused = await row(c, 'www.open.com', 'pending_verification', 'o3').then(() => false, () => true);

  await migration.up(qi(), Sequelize);
  await migration.up(qi(), Sequelize);
  expect(refused).toBe(true);
  expect(await indexNames()).toContain('domains_hostname_verified_unique');
});
