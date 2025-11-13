// full-file: src/telegram.js
const https = require('https');

function sendTelegram(text) {
  return new Promise((resolve, reject) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.log('Telegram envs missing; skipping notification.');
      return resolve();
    }
    const postData = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const opts = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { const j = JSON.parse(body); if (j.ok) resolve(j); else reject(j); }
        catch (e) { resolve(body); }
      });
    });
    req.on('error', err => reject(err));
    req.write(postData);
    req.end();
  });
}

module.exports = { sendTelegram };
