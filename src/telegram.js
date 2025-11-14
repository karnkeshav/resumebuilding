// full-file: src/telegram.js
// Provides helper functions to send Telegram messages and messages with inline buttons.
// Uses TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables.

const https = require('https');

function apiRequest(path, method = 'GET', body = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const opts = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${token}/${path}`,
    method,
    headers: {}
  };
  return new Promise((resolve, reject) => {
    const reqBody = body ? JSON.stringify(body) : null;
    if (reqBody) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(reqBody);
    }
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j);
        } catch (e) {
          resolve({ ok: false, raw: data });
        }
      });
    });
    req.on('error', err => reject(err));
    if (reqBody) req.write(reqBody);
    req.end();
  });
}

async function sendTelegram(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.log('TELEGRAM_CHAT_ID not set; skipping sendTelegram.');
    return;
  }
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  try {
    return await apiRequest('sendMessage', 'POST', body);
  } catch (e) {
    console.log('sendTelegram error:', e && e.message ? e.message : e);
    throw e;
  }
}

/**
 * Send a job message with inline buttons.
 * - chatId optional (if not provided uses TELEGRAM_CHAT_ID)
 * - payloadId is a short id you include in callback_data (e.g. filename or jobid)
 *
 * Buttons callback_data format:
 *   APPROVE:<payloadId>
 *   SKIP:<payloadId>
 */
async function sendJobWithButtons({ chatId, text, payloadId }) {
  chatId = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    console.log('TELEGRAM_CHAT_ID not set; skipping sendJobWithButtons.');
    return;
  }
  if (!payloadId) payloadId = `${Date.now()}`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: 'Build Resume ✅', callback_data: `APPROVE:${payloadId}` },
        { text: 'Skip ⛔', callback_data: `SKIP:${payloadId}` }
      ]
    ]
  };

  const body = {
    chat_id: chatId,
    text,
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  };

  try {
    return await apiRequest('sendMessage', 'POST', body);
  } catch (e) {
    console.log('sendJobWithButtons error:', e && e.message ? e.message : e);
    throw e;
  }
}

async function getUpdates(offset = null, timeout = 0) {
  const path = `getUpdates?timeout=${timeout}${offset ? `&offset=${offset}` : ''}`;
  try {
    return await apiRequest(path, 'GET', null);
  } catch (e) {
    console.log('getUpdates error:', e && e.message ? e.message : e);
    throw e;
  }
}

/**
 * Answer callback query (acknowledge button press) to remove "loading" in Telegram client.
 * callbackQueryId is callback_query.id
 */
async function answerCallbackQuery(callbackQueryId, text = '') {
  try {
    return await apiRequest('answerCallbackQuery', 'POST', { callback_query_id: callbackQueryId, text });
  } catch (e) {
    console.log('answerCallbackQuery error:', e && e.message ? e.message : e);
  }
}

module.exports = {
  sendTelegram,
  sendJobWithButtons,
  getUpdates,
  answerCallbackQuery
};