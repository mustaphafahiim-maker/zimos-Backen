'use strict';

const { postJson } = require('./http');

/**
 * Telegram Bot API: the merchant makes a bot with @BotFather, adds it to the
 * group and gives us its token and the group's chat id. sendMessage as plain
 * text (no parse_mode), so nothing in an order (a product name, a typed
 * governorate) can format or break the message.
 */
const apiBase = () => (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

module.exports = {
  code: 'telegram',
  sandbox: false,
  maxLength: 4096,
  async send(credentials, text) {
    return postJson('Telegram', `${apiBase()}/bot${credentials.botToken}/sendMessage`, {
      chat_id: credentials.chatId,
      text,
      disable_web_page_preview: true,
    });
  },
};
