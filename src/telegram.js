// full-file: src/telegram.js
// Minimal Telegram helper: send messages (optionally with inline buttons), getUpdates polling,
// answer callback queries. Uses TELEGRAM_BOT_TOKEN from env.

const https = require('https');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.warn('TELEGRAM_BOT_TOKEN not set in env; telegram functions will noop.');
}

function api(path, method = 'GET', body = null) {
  if (!TOKEN) return Promise.resolve(null);
  const opts = {
    hostname: 'api.telegram.org',
    port: 443,
    path: `/bot${TOKEN}/${path}`,
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * sendTelegram(text, inlineKeyboard)
 * inlineKeyboard example:
 *  [
 *    [{ text: "Build Resume", callback_data: "BUILD|<id>" }, { text: "Skip", callback_data: "SKIP|<id>" }]
 *  ]
 */
async function sendTelegram(text, inlineKeyboard = null) {
  if (!TOKEN) return;
  const body = { chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' };
  if (inlineKeyboard) body.reply_markup = { inline_keyboard: inlineKeyboard };
  try {
    const res = await api('sendMessage', 'POST', body);
    return res;
  } catch (e) {
    console.error('sendTelegram error', e && e.message ? e.message : e);
    throw e;
  }
}

async function getUpdates(offset = 0, timeout = 0) {
  if (!TOKEN) return null;
  const path = `getUpdates?offset=${offset}&timeout=${timeout}`;
  try { return await api(path, 'GET'); }
  catch (e) { console.error('getUpdates error', e && e.message ? e.message : e); return null; }
}

async function answerCallbackQuery(callback_query_id, text = '') {
  if (!TOKEN) return null;
  try { return await api('answerCallbackQuery', 'POST', { callback_query_id, text }); }
  catch (e) { console.error('answerCallbackQuery error', e && e.message ? e.message : e); return null; }
}

async function editMessageReplyMarkup(chat_id, message_id) {
  if (!TOKEN) return null;
  try {
    return await api('editMessageReplyMarkup', 'POST', { chat_id, message_id });
  } catch (e) {
    console.error('editMessageReplyMarkup error', e && e.message ? e.message : e);
    return null;
  }
}

module.exports = { sendTelegram, getUpdates, answerCallbackQuery, editMessageReplyMarkup };
