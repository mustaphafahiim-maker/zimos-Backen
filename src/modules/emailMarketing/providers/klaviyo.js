'use strict';

const { call } = require('./http');

/*
 * Klaviyo API (revision 2024-10-15; spec-gaps item 182) with a private API
 * key (lists:read/write, profiles:write, subscriptions:write). Contacts are
 * subscribed to the list's email marketing in bulk jobs of up to 100, which
 * Klaviyo runs by itself; the profile's properties carry the tags.
 */

const BASE = 'https://a.klaviyo.com/api';
const headers = (c) => ({ authorization: `Klaviyo-API-Key ${c.apiKey || ''}`, revision: '2024-10-15', accept: 'application/vnd.api+json' });
const CHUNK = 100;

module.exports = {
  code: 'klaviyo',
  name: 'Klaviyo',
  isTest: false,
  credentialFields: [{ key: 'apiKey', label: { en: 'Private API key', ar: 'مفتاح API الخاص' }, secret: true, required: true }],

  async verifyCredentials(c) {
    const json = await call('GET', `${BASE}/accounts/`, { headers: headers(c) });
    const account = json && json.data && json.data[0];
    return { accountName: (account && account.attributes && account.attributes.contact_information && account.attributes.contact_information.organization_name) || 'Klaviyo' };
  },

  async lists(c) {
    const json = await call('GET', `${BASE}/lists/?fields[list]=name`, { headers: headers(c) });
    return ((json && json.data) || []).map((l) => ({ id: l.id, name: l.attributes.name, memberCount: null }));
  },

  async upsertContacts(c, listId, contacts) {
    for (let i = 0; i < contacts.length; i += CHUNK) {
      await call('POST', `${BASE}/profile-subscription-bulk-create-jobs/`, {
        headers: { ...headers(c), 'content-type': 'application/vnd.api+json' },
        body: {
          data: {
            type: 'profile-subscription-bulk-create-job',
            attributes: {
              custom_source: 'Zimos',
              profiles: {
                data: contacts.slice(i, i + CHUNK).map((p) => ({
                  type: 'profile',
                  attributes: { email: p.email, subscriptions: { email: { marketing: { consent: 'SUBSCRIBED' } } } },
                })),
              },
            },
            relationships: { list: { data: { type: 'list', id: listId } } },
          },
        },
      });
    }
    // Names and tags go on the profile itself (the subscription job takes only the address).
    for (const p of contacts) {
      await call('POST', `${BASE}/profile-import/`, {
        headers: { ...headers(c), 'content-type': 'application/vnd.api+json' },
        body: { data: { type: 'profile', attributes: { email: p.email, first_name: p.firstName || undefined, last_name: p.lastName || undefined, properties: { zimos_tags: p.tags, zimos_source: p.source || null } } } },
      });
    }
    return { synced: contacts.length };
  },

  // Someone who withdrew their consent: unsubscribed from the list's email marketing.
  async unsubscribe(c, listId, email) {
    await call('POST', `${BASE}/profile-subscription-bulk-delete-jobs/`, {
      headers: { ...headers(c), 'content-type': 'application/vnd.api+json' },
      body: {
        data: {
          type: 'profile-subscription-bulk-delete-job',
          attributes: { profiles: { data: [{ type: 'profile', attributes: { email, subscriptions: { email: { marketing: { consent: 'UNSUBSCRIBED' } } } } }] } },
          relationships: { list: { data: { type: 'list', id: listId } } },
        },
      },
    });
  },
};
