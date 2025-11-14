// full-file: src/bot-handler.js
// Polls Telegram for callback queries (button presses) and simple APPROVE/REJECT messages.
// Writes selections to state/selected.json and stores offset in state/offset.txt.
// Run this regularly (cron) in GitHub Actions.

const fs = require('fs');
const path = require('path');
const { getUpdates, answerCallbackQuery, editMessageReplyMarkup, sendTelegram } = require('./telegram');

const STATE_DIR = path.resolve('state');
const OFFSET_FILE = path.join(STATE_DIR, 'offset.txt');
const SELECTED_FILE = path.join(STATE_DIR, 'selected.json');

// ensure state dir
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

function loadOffset() {
  try { return Number(fs.readFileSync(OFFSET_FILE, 'utf8') || 0); }
  catch (e) { return 0; }
}
function saveOffset(n) { fs.writeFileSync(OFFSET_FILE, String(n), 'utf8'); }

function loadSelected() {
  try { return JSON.parse(fs.readFileSync(SELECTED_FILE, 'utf8')); }
  catch (e) { return { pending: [] }; }
}
function saveSelected(obj) { fs.writeFileSync(SELECTED_FILE, JSON.stringify(obj, null, 2), 'utf8'); }

function pushSelection(entry) {
  const state = loadSelected();
  state.pending = state.pending || [];
  // avoid duplicates by file or jobId
  if (!state.pending.find(p => p.id === entry.id || p.file === entry.file)) {
    state.pending.push(entry);
    saveSelected(state);
    return true;
  }
  return false;
}

async function handleCallback(q) {
  // q is callback_query object
  const id = q.id;
  const data = q.data || '';
  const from = q.from && q.from.id;
  const message = q.message || {};
  // expected data formats: "BUILD|<filename>" or "SKIP|<filename>"
  const parts = data.split('|');
  const action = parts[0];
  const file = parts.slice(1).join('|');

  try {
    if (action === 'BUILD') {
      const entry = { id: file, file, link: null, requested_by: from, ts: Date.now() };
      const added = pushSelection(entry);
      await answerCallbackQuery(id, added ? 'Queued for tailoring ✅' : 'Already queued');
      // optionally remove buttons
      if (message.chat && message.message_id) await editMessageReplyMarkup(message.chat.id, message.message_id);
      // send confirmation
      await sendTelegram(`Queued *${file}* for resume tailoring.`);
    } else if (action === 'SKIP') {
      await answerCallbackQuery(id, 'Skipped');
      if (message.chat && message.message_id) await editMessageReplyMarkup(message.chat.id, message.message_id);
    } else {
      await answerCallbackQuery(id, 'Unknown action');
    }
  } catch (e) {
    console.error('handleCallback error', e && e.message ? e.message : e);
  }
}

async function handleMessage(msg) {
  // fallback: text messages like "APPROVE filename" or "REJECT filename"
  if (!msg || !msg.text) return;
  const txt = msg.text.trim();
  const parts = txt.split(/\s+/);
  const cmd = parts[0].toUpperCase();
  const rest = parts.slice(1).join(' ');
  if (cmd === 'APPROVE' || cmd === 'BUILD') {
    const entry = { id: rest || `manual-${Date.now()}`, file: rest, link: null, requested_by: msg.from && msg.from.id, ts: Date.now() };
    const added = pushSelection(entry);
    await sendTelegram(added ? `Queued *${rest}* for tailoring.` : `${rest} already queued.`);
  } else if (cmd === 'SKIP' || cmd === 'REJECT') {
    await sendTelegram(`Skipped *${rest}*`);
  }
}

async function pollOnce() {
  const offset = loadOffset();
  const res = await getUpdates(offset + 1, 2).catch(e => { console.error('getUpdates fail', e && e.message); return null; });
  if (!res || !res.result) return;
  let max = offset;
  for (const u of res.result) {
    if (u.update_id > max) max = u.update_id;
    if (u.callback_query) {
      await handleCallback(u.callback_query);
    } else if (u.message) {
      await handleMessage(u.message);
    }
  }
  if (max > offset) saveOffset(max + 1);
}

async function main() {
  try {
    await pollOnce();
    console.log('Polling done.');
  } catch (e) {
    console.error('Bot handler error', e && e.message ? e.message : e);
    process.exit(1);
  }
}

if (require.main === module) main();
module.exports = { pollOnce };
