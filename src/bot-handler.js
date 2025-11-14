// full-file: src/bot-handler.js
// Polls Telegram for callback queries and text commands.
// Persists state/selected.json and commits to repo when changed.
// Supports: BUILD|<file>, SKIP|<file>, APPROVE/BUILD <file>, SKIP/REJECT <file>, ADD <title, location>, APPLY <file>

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getUpdates, answerCallbackQuery, editMessageReplyMarkup, sendTelegram } = require('./telegram');

const STATE_DIR = path.resolve('state');
const OFFSET_FILE = path.join(STATE_DIR, 'offset.txt');
const SELECTED_FILE = path.join(STATE_DIR, 'selected.json');
const JOBS_FILE = path.resolve('jobs.txt');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// --- helpers: load/save state/offset
function loadOffset() {
  try { return Number(fs.readFileSync(OFFSET_FILE, 'utf8') || 0); } catch (e) { return 0; }
}
function saveOffset(n) { fs.writeFileSync(OFFSET_FILE, String(n), 'utf8'); }

function loadSelected() {
  try { return JSON.parse(fs.readFileSync(SELECTED_FILE, 'utf8')); }
  catch (e) { return { pending: [] }; }
}
function saveSelected(obj) { fs.writeFileSync(SELECTED_FILE, JSON.stringify(obj, null, 2), 'utf8'); }

// commit helper (uses GITHUB_TOKEN from env; requires checkout with persist-credentials)
function gitCommitAndPush(files, message) {
  try {
    // stage files
    execSync(`git add ${files.join(' ')}`, { stdio: 'inherit' });
    // commit if there are changes
    try {
      execSync(`git diff --staged --quiet || git commit -m "${message.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
      // push current branch (workflow will run on main or checkout branch)
      execSync('git push', { stdio: 'inherit' });
    } catch (e) {
      // nothing to commit or commit failed
      console.log('git commit/push: no changes or failed', e && e.message ? e.message : e);
    }
  } catch (e) {
    console.error('gitCommitAndPush error', e && e.message ? e.message : e);
  }
}

// push selection into pending and persist/commit
function pushSelection(entry) {
  const state = loadSelected();
  state.pending = state.pending || [];
  if (!state.pending.find(p => p.id === entry.id || p.file === entry.file)) {
    state.pending.push(entry);
    saveSelected(state);
    // commit selected.json
    try { gitCommitAndPush(['state/selected.json'], `JobBot: queue ${entry.id}`); } catch (e) {}
    return true;
  }
  return false;
}

// remove selection and commit
function removeSelectionById(idOrFile) {
  const state = loadSelected();
  const before = (state.pending || []).length;
  state.pending = (state.pending || []).filter(p => p.id !== idOrFile && p.file !== idOrFile);
  const after = state.pending.length;
  saveSelected(state);
  if (after !== before) {
    try { gitCommitAndPush(['state/selected.json'], `JobBot: removed ${idOrFile}`); } catch (e) {}
    return true;
  }
  return false;
}

// append a new search line to jobs.txt (and commit)
function appendJobsTxt(line) {
  const trimmed = (line || '').trim();
  if (!trimmed) return false;
  // ensure jobs.txt exists
  if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, '', 'utf8');
  const existing = fs.readFileSync(JOBS_FILE, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (existing.includes(trimmed)) return false;
  existing.push(trimmed);
  fs.writeFileSync(JOBS_FILE, existing.join('\n'), 'utf8');
  try { gitCommitAndPush(['jobs.txt'], `JobBot: add search "${trimmed}"`); } catch (e) {}
  return true;
}

// Try to extract a job filename/id from a callback or text arg
function normaliseFileArg(arg) {
  if (!arg) return null;
  const s = arg.trim();
  // if argument is a full url or filename, we keep as file
  return s;
}

// handle callback_query
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
    } else if (action === 'SKIP' || action === 'REJECT') {
      const removed = removeSelectionById(file);
      await answerCallbackQuery(id, removed ? 'Skipped and removed' : 'Already skipped');
      if (message.chat && message.message_id) await editMessageReplyMarkup(message.chat.id, message.message_id);
    } else {
      await answerCallbackQuery(id, 'Unknown action');
    }
  } catch (e) {
    console.error('handleCallback error', e && e.message ? e.message : e);
  }
}

// handle plain messages (mobile-friendly)
async function handleMessage(msg) {
  if (!msg || !msg.text) return;
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
      const removed = removeSelectionById(file);
      await sendTelegram(removed ? `Skipped and removed *${file}*` : `${file} not in queue.`);
    } else if (cmd === 'ADD') {
      // ADD <title, location>
      const added = appendJobsTxt(rest);
      await sendTelegram(added ? `Added search: "${rest}".` : `Already present or invalid: "${rest}".`);
    } else if (cmd === 'APPLY') {
      // reply with direct job URL and mailto template if available
      const file = normaliseFileArg(rest);
      if (!file) { await sendTelegram('Provide filename to get Apply options. Example: APPLY kroll-...'); return; }
      // look up the job draft in outbox to fetch URL inside file
      const outpath = path.join('outbox', file);
      if (!fs.existsSync(outpath)) { await sendTelegram(`Draft not found: ${file}`); return; }
      const md = fs.readFileSync(outpath, 'utf8');
      // try to extract Job URL from the md (looking for line "URL: ")
      const match = md.match(/\*\*URL:\*\*\s*(\S+)/);
      const jobUrl = match ? match[1] : null;
      const buttons = [];
      if (jobUrl) buttons.push([{ text: 'Open Job', url: jobUrl }]);
      // mailto template: recruiter email unknown — provide generic mailto with subject and body
      const subject = encodeURIComponent(`Application: ${file}`);
      const body = encodeURIComponent(`Hi,\n\nI am interested in the role ${file}. Please find my resume attached. Could you guide me on the application process?\n\nRegards,\nKeshav Karn\n`);
      buttons.push([{ text: 'Email Recruiter', url: `mailto:?subject=${subject}&body=${body}` }]);
      // send message with buttons
      await sendTelegram(`Apply options for *${file}*`, buttons);
    } else {
      // unknown command: give help
      await sendTelegram('Commands: APPROVE|BUILD <file>, SKIP <file>, ADD <Title, Location>, APPLY <file>');
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
