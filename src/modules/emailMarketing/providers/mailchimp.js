'use strict';

const crypto = require('crypto');
const { call, err } = require('./http');

/*
 * Mailchimp Marketing API 3.0 (spec-gaps item 182). The API key ends in its
 * data centre ("…-us21"), which names the host. A contact is upserted into
 * the audience by the MD5 of its lower-cased email, as subscribed (only
 * contacts who agreed to marketing are ever sent), then tagged.
 */

const base = (c) => {
  const dc = String(c.apiKey || '').split('-')[1];
  if (!/^[a-z]{2,4}\d{1,3}$/.test(dc || '')) throw err('EMAIL_MARKETING_INVALID_CREDENTIALS', 422, 'A Mailchimp API key ends in its data centre, like "-us21"');
  return `https://${dc}.api.mailchimp.com/3.0`;
};
const auth = (c) => ({ authorization: `Basic ${Buffer.from(`zimos:${c.apiKey}`).toString('base64')}` });
const hash = (email) => crypto.createHash('md5').update(String(email).toLowerCase()).digest('hex');

module.exports = {
  code: 'mailchimp',
  name: 'Mailchimp',
  isTest: false,
  credentialFields: [{ key: 'apiKey', label: { en: 'API key', ar: 'مفتاح API' }, secret: true, required: true }],

  async verifyCredentials(c) {
    const json = await call('GET', `${base(c)}/?fields=account_name`, { headers: auth(c) });
    return { accountName: (json && json.account_name) || 'Mailchimp' };
  },

  async lists(c) {
    const json = await call('GET', `${base(c)}/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count`, { headers: auth(c) });
    return ((json && json.lists) || []).map((l) => ({ id: l.id, name: l.name, memberCount: (l.stats && l.stats.member_count) ?? null }));
  },

  async upsertContacts(c, listId, contacts) {
    let synced = 0;
    for (const p of contacts) {
      const member = `${base(c)}/lists/${encodeURIComponent(listId)}/members/${hash(p.email)}`;
      await call('PUT', member, {
        headers: auth(c),
        body: {
          email_address: p.email,
          status_if_new: 'subscribed',
          merge_fields: { FNAME: p.firstName || '', LNAME: p.lastName || '', ...(p.phone ? { PHONE: p.phone } : {}) },
        },
      });
      if (p.tags.length) await call('POST', `${member}/tags`, { headers: auth(c), body: { tags: p.tags.map((name) => ({ name, status: 'active' })) } });
      synced += 1;
    }
    return { synced };
  },

  // Someone who withdrew their consent: unsubscribed (kept in the audience, as Mailchimp wants).
  async unsubscribe(c, listId, email) {
    await call('PATCH', `${base(c)}/lists/${encodeURIComponent(listId)}/members/${hash(email)}`, { headers: auth(c), body: { status: 'unsubscribed' } }).catch((e) => {
      if (e.code !== 'EMAIL_MARKETING_LIST_NOT_FOUND') throw e; // never subscribed: nothing to do
    });
  },
};
