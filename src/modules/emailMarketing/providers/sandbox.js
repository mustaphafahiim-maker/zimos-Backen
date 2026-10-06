'use strict';

const { err } = require('./http');

/*
 * The test provider: no network. Any API key except "invalid" connects; two
 * lists; contacts are kept in memory (per process) so a test can read them
 * back with `members(listId)`.
 */

const LISTS = [
  { id: 'sandbox-newsletter', name: 'Newsletter (test)' },
  { id: 'sandbox-buyers', name: 'Buyers (test)' },
];
const store = new Map(); // listId → Map(email → contact)

module.exports = {
  code: 'sandbox',
  name: 'Test email list',
  isTest: true,
  credentialFields: [{ key: 'apiKey', label: { en: 'Any test key', ar: 'أي مفتاح تجريبي' }, secret: true, required: true }],
  async verifyCredentials(c) {
    if (!c.apiKey || c.apiKey === 'invalid') throw err('EMAIL_MARKETING_INVALID_CREDENTIALS', 422, 'The service refused the API key');
    return { accountName: 'Test account' };
  },
  async lists() {
    return LISTS.map((l) => ({ ...l, memberCount: store.has(l.id) ? store.get(l.id).size : 0 }));
  },
  async upsertContacts(c, listId, contacts) {
    if (!LISTS.some((l) => l.id === listId)) throw err('EMAIL_MARKETING_LIST_NOT_FOUND', 404, 'That list was not found');
    if (!store.has(listId)) store.set(listId, new Map());
    for (const p of contacts) store.get(listId).set(p.email.toLowerCase(), p);
    return { synced: contacts.length };
  },
  async unsubscribe(c, listId, email) {
    const list = store.get(listId);
    if (list && list.has(email.toLowerCase())) list.get(email.toLowerCase()).unsubscribed = true;
  },
  members: (listId) => [...((store.get(listId) || new Map()).values())],
};
