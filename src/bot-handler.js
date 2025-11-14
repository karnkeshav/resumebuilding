// full-file: src/bot-handler.js
// Poll Telegram callbacks/messages. SKIP removes draft from outbox and commits.
// BUILD queues the draft and commits; after queue commit it triggers resume-builder via git push.
// Also handles ADD <title>, and YES/NO replies for the 12h prompt.
// Requires: src/telegram.js (sendTelegram, getUpdates, answerCallbackQuery, editMessageReplyMarkup)
// Must run from GitHub Actions runner with persist-credentials and GITHUB_TOKEN available.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getUpdates, answerCallbackQuery, editMessageReplyMarkup, sendTelegram } = require('./telegram');

const STATE_DIR = path.resolve('state');
const OFFSET_FILE = path.join(STATE_DIR, 'offset.txt');
const SELECTED_FILE = path.join(STATE_DIR, 'selected.json');
const JOBS_FILE = path.resolve('jobs.txt');
const OUTBOX_DIR = path.resolve('outbox');

const ALLOWED_CHAT = process.env.TELEGRAM_CHAT_ID ? String(process.env.TELEGRAM_CHAT_ID) : null;

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });

function loadOffset() {
  try { return Number(fs.readFileSync(OFFSET_FILE, 'utf8') || 0); } catch (e) { return 0; }
}
function saveOffset(n) { fs.writeFileSync(OFFSET_FILE, String(n), 'utf8'); }

function loadSelected() {
  try { return JSON.parse(fs.readFileSync(SELECTED_FILE, 'utf8')); }
  catch (e) { return { pending: [] }; }
}
function saveSelected(obj) { fs.writeFileSync(SELECTED_FILE, JSON.stringify(obj, null, 2), 'utf8'); }

function gitCommitPush(files, msg) {
  try {
    execSync('git config user.email "jobbot@users.noreply.github.com"');
    execSync('git config user.name "jobbot[bot]"');
    execSync(`git add ${files.join(' ')}`, { stdio: 'inherit' });
    execSync('git diff --staged --quiet || git commit -m "' + msg.replace(/"/g, '\\"') + '"', { stdio: 'inherit' });
    execSync('git push', { stdio: 'inherit' });
  } catch (e) {
    console.error('gitCommitPush failed (non-fatal):', e && e.message ? e.message : e);
  }
}

function pushSelection(entry) {
  const state = loadSelected();
  state.pending = state.pending || [];
  if (!state.pending.find(p => p.id === entry.id || p.file === entry.file)) {
    state.pending.push(entry);
    saveSelected(state);
    // commit state to persist selection
    gitCommitPush(['state/selected.json'], `JobBot: queue ${entry.id}`);
    return true;
  }
  return false;
}

function removeSelectionById(idOrFile) {
  const state = loadSelected();
  const before = (state.pending || []).length;
  state.pending = (state.pending || []).filter(p => p.id !== idOrFile && p.file !== idOrFile);
  const after = state.pending.length;
  saveSelected(state);
  if (after !== before) {
    gitCommitPush(['state/selected.json'], `JobBot: removed ${idOrFile}`);
    return true;
  }
  return false;
}

function appendJobsTxt(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return false;
  if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, '', 'utf8');
  const existing = fs.readFileSync(JOBS_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (existing.includes(trimmed)) return false;
  existing.push(trimmed);
  fs.writeFileSync(JOBS_FILE, existing.join('\n'), 'utf8');
  gitCommitPush(['jobs.txt'], `JobBot: add search "${trimmed}"`);
  return true;
}

function normaliseFileArg(arg) {
  if (!arg) return null;
  return arg.trim();
}

async function handleCallback(q) {
  const id = q.id;
  const data = q.data || '';
  const from = q.from && q.from.id;
  const message = q.message || {};
  const parts = data.split('|');
  const action = (parts[0] || '').toUpperCase();
  const file = parts.slice(1).join('|') || (`unknown-${Date.now()}`);

  try {
    if (action === 'BUILD' || action === 'APPROVE') {
      const entry = { id: file, file, link: null, requested_by: from, ts: Date.now() };
      const added = pushSelection(entry);
      await answerCallbackQuery(id, added ? 'Queued for tailoring ✅' : 'Already queued');
      if (message.chat && message.message_id) await editMessageReplyMarkup(message.chat.id, message.message_id);
      await sendTelegram(`Queued *${file}* for resume tailoring.`);
      // resume-builder workflow will run on push of state/selected.json
    } else if (action === 'SKIP' || action === 'REJECT') {
      const outpath = path.join(OUTBOX_DIR, file);
      let deleted = false;
      if (fs.existsSync(outpath)) {
        try { fs.unlinkSync(outpath); deleted = true; } catch(e){ console.error('unlink failed', e); }
      }
      removeSelectionById(file);
      gitCommitPush([`outbox/${file}`, 'state/selected.json'], `JobBot: delete outbox ${file}`);
      await answerCallbackQuery(id, deleted ? 'Skipped and deleted ✅' : 'Skipped');
      if (message.chat && message.message_id) await editMessageReplyMarkup(message.chat.id, message.message_id);
      await sendTelegram(deleted ? `Skipped and deleted *${file}* from outbox.` : `Skipped *${file}*.`);
    } else {
      await answerCallbackQuery(id, 'Unknown action');
    }
  } catch (e) {
    console.error('handleCallback error', e && e.message ? e.message : e);
  }
}

async function handleMessage(msg) {
  if (!msg || !msg.text) return;
  if (ALLOWED_CHAT && String(msg.chat && msg.chat.id) !== ALLOWED_CHAT) return;

  const txt = msg.text.trim();
  const parts = txt.split(/\s+/);
  const cmd = (parts[0] || '').toUpperCase();
  const rest = txt.substring((parts[0] || '').length).trim();

  try {
    if (cmd === 'APPROVE' || cmd === 'BUILD') {
      const file = normaliseFileArg(rest) || `manual-${Date.now()}`;
      const entry = { id: file, file, link: null, requested_by: msg.from && msg.from.id, ts: Date.now() };
      const added = pushSelection(entry);
      await sendTelegram(added ? `Queued *${file}* for tailoring.` : `${file} already queued.`);
    } else if (cmd === 'SKIP' || cmd === 'REJECT') {
      const file = normaliseFileArg(rest);
      if (!file) { await sendTelegram('Please provide filename to skip.'); return; }
      const outpath = path.join(OUTBOX_DIR, file);
      let deleted = false;
      if (fs.existsSync(outpath)) {
        try { fs.unlinkSync(outpath); deleted = true; } catch(e){ console.error('unlink failed', e); }
      }
      const removed = removeSelectionById(file);
      gitCommitPush([`outbox/${file}`, 'state/selected.json'], `JobBot: skipped ${file}`);
      await sendTelegram(deleted ? `Skipped and deleted *${file}*` : `${file} not found but removed from queue.`);
    } else if (cmd === 'ADD') {
      const added = appendJobsTxt(rest);
      await sendTelegram(added ? `Added search: "${rest}".` : `Already present or invalid: "${rest}".`);
    } else if (cmd === 'APPLY') {
      const file = normaliseFileArg(rest);
      if (!file) { await sendTelegram('Provide filename to get Apply options. Example: APPLY kroll-...'); return; }
      const outpath = path.join('outbox', file);
      if (!fs.existsSync(outpath)) { await sendTelegram(`Draft not found: ${file}`); return; }
      const md = fs.readFileSync(outpath, 'utf8');
      const match = md.match(/\*\*URL:\*\*\s*(\S+)/);
      const jobUrl = match ? match[1] : null;
      const buttons = [];
      if (jobUrl) buttons.push([{ text: 'Open Job', url: jobUrl }]);
      const subject = encodeURIComponent(`Application: ${file}`);
      const body = encodeURIComponent(`Hi,\n\nI am interested in the role ${file}. Please find my resume attached.\n\nRegards,\nKeshav Karn\n`);
      buttons.push([{ text: 'Email Recruiter', url: `mailto:?subject=${subject}&body=${body}` }]);
      await sendTelegram(`Apply options for *${file}*`, buttons);
    } else if (cmd === 'YES' || cmd === 'NO') {
      fs.writeFileSync(path.join(STATE_DIR, 'last_12h_response.txt'), `${cmd}|${Date.now()}`, 'utf8');
      await sendTelegram(cmd === 'YES' ? 'Okay — send me new titles via ADD <title, location>.' : 'Understood. I will ask again in 12 hours.');
    } else if (cmd === '/HELP' || cmd === 'HELP') {
      await sendTelegram('Commands: APPROVE|BUILD <file>, SKIP <file>, ADD <Title, Location>, APPLY <file>, YES, NO');
    } else {
      // ignore other casual messages to avoid spam
      return;
    }
  } catch (e) {
    console.error('handleMessage error', e && e.message ? e.message : e);
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
