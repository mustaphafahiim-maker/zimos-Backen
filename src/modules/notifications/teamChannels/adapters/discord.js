'use strict';

const { postJson } = require('./http');

/**
 * Discord channel webhook (https://discord.com/api/webhooks/<id>/<token>):
 * Channel settings → Integrations → Webhooks → Copy URL. allowed_mentions is
 * empty, so "@everyone" typed by a shopper pings nobody.
 */
module.exports = {
  code: 'discord',
  sandbox: false,
  maxLength: 2000,
  async send(credentials, text) {
    return postJson('Discord', credentials.webhookUrl, { content: text, allowed_mentions: { parse: [] } });
  },
};
