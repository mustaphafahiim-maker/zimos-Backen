'use strict';

const logger = require('../../../../core/utils/logger');

/**
 * Nothing leaves the server: the message is written to the log and counted as
 * sent. A chat id or webhook URL ending in "sandbox-fail" fails, so the
 * failure path (last error, pause after 10) can be tried. Outside production only.
 */
const sent = [];

module.exports = {
  code: 'sandbox',
  sandbox: true,
  maxLength: 4096,
  sent,
  async send(credentials, text, provider) {
    const target = credentials.chatId || credentials.webhookUrl || '';
    if (/sandbox-fail$/.test(String(target))) {
      const err = new Error(`${provider} (sandbox) refused the message`);
      err.permanent = true;
      throw err;
    }
    sent.push({ provider, text, at: new Date() });
    if (sent.length > 50) sent.shift();
    logger.info(`[team-channel:${provider}:sandbox] ${text.split('\n')[0]}`);
    return { status: 200 };
  },
};
