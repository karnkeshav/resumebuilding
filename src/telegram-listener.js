// full-file: src/telegram-listener.js
// Polls Telegram getUpdates and processes callback_query events.
// Records approvals (APPROVE:<id>) and skips into state/selected.json
// Keeps last update offset in data/last_update.json so messages aren't reprocessed.

const fs = require('fs');
const path = require('path');
const { getUpdates, answerCallbackQuery } = require('./telegram');

const LAST_UPDATE = path.join('data', 'last_update.json');
const SELECTED = path.join('state', 'selected.json');

function readLastOffset() {
  try {
    if (!fs.existsSync(LAST_UPDATE)) return null;
    const j = JSON.parse(fs.readFileSync(LAST_UPDATE, 'utf8'));
    return j.offset || null;
  } catch (e) {
    return null;
  }
}

function writeLastOffset(offset) {
  try {
    fs.mkdirSync(path.dirname(LAST_UPDATE), { recursive: true });
    fs.writeFileSync(LAST_UPDATE, JSON.stringify({ offset }, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write last_update', e && e.message ? e.message : e);
  }
}

function readSelected() {
  try {
    if (!fs.existsSync(SELECTED)) return { pending: [] };
    return JSON.parse(fs.readFileSync(SELECTED, 'utf8'));
  } catch (e) {
    return { pending: [] };
  }
}

function writeSelected(obj) {
  try {
    fs.mkdirSync(path.dirname(SELECTED), { recursive: true });
    fs.writeFileSync(SELECTED, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to write selected.json', e && e.message ? e.message : e);
  }
}

async function main() {
  const offsetObj = readLastOffset();
  let offset = offsetObj;
  try {
    const resp = await getUpdates(offset, 0); // immediate return
    if (!resp || !resp.ok) {
      console.log('getUpdates returned not ok', resp);
      return;
    }
    const updates = resp.result || [];
    if (updates.length === 0) {
      console.log('No new telegram updates.');
      return;
    }

    const selected = readSelected();

    for (const u of updates) {
      // update offset to last_update_id + 1 to mark processed
      if (u.update_id !== undefined) offset = (u.update_id + 1);

      // handle callback_query events for inline buttons
      if (u.callback_query) {
        const cq = u.callback_query;
        const data = cq.data || '';
        const from = (cq.from && (cq.from.id || cq.from.username)) || 'unknown';
        console.log('callback_query from', from, 'data=', data);

        // expected formats: APPROVE:<payloadId> or SKIP:<payloadId>
        const parts = data.split(':');
        const cmd = parts[0] ? parts[0].toUpperCase() : '';
        const payloadId = parts[1] || '';

        // ack the callback so the client stops showing the spinner
        try { await answerCallbackQuery(cq.id, cmd === 'APPROVE' ? 'Build queued' : 'Skipped'); } catch (e) { console.log('ack error', e && e.message); }

        if (cmd === 'APPROVE') {
          // record in selected.json if not duplicate
          const exists = selected.pending.find(p => p.id === payloadId);
          if (!exists) {
            selected.pending.push({ id: payloadId, ts: Date.now(), source: 'telegram' });
            writeSelected(selected);
            console.log('Recorded APPROVE for', payloadId);
          } else {
            console.log('Already recorded', payloadId);
          }
        } else if (cmd === 'SKIP') {
          // optionally record skip or ignore
          console.log('User skipped', payloadId);
        } else {
          console.log('Unknown callback command', data);
        }
      } else if (u.message) {
        // optional: handle plain text commands like "APPROVE <id>"
        const msg = u.message;
        const text = (msg.text || '').trim();
        if (text) {
          const parts = text.split(/\s+/);
          const cmd = (parts[0] || '').toUpperCase();
          if (cmd === 'APPROVE' && parts[1]) {
            const payloadId = parts[1];
            const selectedObj = readSelected();
            if (!selectedObj.pending.find(p => p.id === payloadId)) {
              selectedObj.pending.push({ id: payloadId, ts: Date.now(), source: 'telegram-text' });
              writeSelected(selectedObj);
              console.log('Recorded APPROVE via text for', payloadId);
            }
          }
        }
      }
    }

    // persist new offset
    if (offset !== null) writeLastOffset(offset);
  } catch (e) {
    console.error('Listener failure', e && e.message ? e.message : e);
  }
}

// run once and exit (workflow will schedule)
main().catch(e => {
  console.error('Unhandled error in telegram-listener', e && e.message ? e.message : e);
  process.exit(1);
});