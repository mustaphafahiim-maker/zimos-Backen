'use strict';

const { postJson } = require('./http');

/**
 * Slack incoming webhook (https://hooks.slack.com/services/…): the merchant
 * adds the "Incoming Webhooks" app to a channel and pastes its URL. Slack's
 * control characters are escaped, so "<!channel>" typed by a shopper is shown
 * as text and pings nobody.
 */
const escapeSlack = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = {
  code: 'slack',
  sandbox: false,
  maxLength: 3000,
  async send(credentials, text) {
    return postJson('Slack', credentials.webhookUrl, { text: escapeSlack(text), unfurl_links: false, unfurl_media: false });
  },
};
