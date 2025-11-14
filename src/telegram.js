// full-file: src/telegram.js
// Simple Telegram helper used by the bot.
// Exports: sendTelegram(text, inlineKeyboard)
//
// Usage:
//   await sendTelegram("Hello", [[{ text: 'Ok', callback_data: 'OK' }]]);
//
// Notes:
// - Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in env.
// - Uses global fetch (Node 18+). If your runner has no fetch, install node-fetch and adjust.

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.warn('Warning: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in env. Telegram disabled.');
}

async function sendTelegram(text, inlineKeyboard = null) {
  if (!token || !chatId) {
    console.log('Telegram disabled, would send:', text);
    return null;
  }

  // Telegram has special characters in Markdown; keep it simple by using MarkdownV2 only when necessary.
  // We'll default to Markdown, but escape only a few troublesome chars if needed.
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown',
    disable_web_page_preview: false
  };

  if (inlineKeyboard) {
    // Expect inlineKeyboard in the format used in index.js:
    // [ [ { text, callback_data }, { text, callback_data } ] ]
    payload.reply_markup = JSON.stringify({ inline_keyboard: inlineKeyboard });
  }

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // 10s timeout fallback not available here; GH actions run should be stable.
    });

    const data = await res.json();
    if (!res.ok || (data && data.ok === false)) {
      console.error('Telegram API error:', data);
      throw new Error(`Telegram send failed: ${JSON.stringify(data)}`);
    }
    return data;
  } catch (err) {
    console.error('sendTelegram error:', err && err.message ? err.message : err);
    throw err;
  }
}

module.exports = { sendTelegram };
