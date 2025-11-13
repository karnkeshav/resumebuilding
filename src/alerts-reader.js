// full-file: src/alerts-reader.js
// Reads keshav_job_alerts.json or keshav_job_alerts.csv (if present) in repo root,
// normalizes into one search line per alert and writes jobs.txt for downstream scripts.
//
// Supported JSON shapes (common):
// - array of objects with fields: title, role, job_title, location, city, country, company
// - object with key "alerts" or "jobs" containing such array
//
// CSV supported columns: title, role, job_title, location, city, country, company
//
// Output: jobs.txt (one line per search): "Title, Location"
// If a row already contains a /jobs/view/ URL, it will be written as-is.

const fs = require('fs');
const path = require('path');
const os = require('os');

const JSON_NAME = 'keshav_job_alerts.json';
const CSV_NAME = 'keshav_job_alerts.csv';
const JOBS_FILE = 'jobs.txt';

function guessTitle(obj) {
  return obj.title || obj.role || obj.job_title || obj.position || '';
}
function guessLocation(obj) {
  return obj.location || obj.city || obj.region || obj.country || '';
}
function isJobUrl(s) {
  return typeof s === 'string' && s.includes('/jobs/view/');
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    if (cols.length === 0) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cols[j] || '';
    }
    rows.push(obj);
  }
  return rows;
}

function loadJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('JSON parse error for', p, e && e.message);
    return null;
  }
}

function loadCsvIfExists(p) {
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return parseCsv(raw);
  } catch (e) {
    console.error('CSV parse error for', p, e && e.message);
    return null;
  }
}

function itemsFromJson(json) {
  if (!json) return [];
  if (Array.isArray(json)) return json;
  if (json.alerts && Array.isArray(json.alerts)) return json.alerts;
  if (json.jobs && Array.isArray(json.jobs)) return json.jobs;
  // as fallback, try to extract values that look like objects
  return Object.values(json).filter(v => typeof v === 'object');
}

function normalizeLine(objOrString) {
  if (typeof objOrString === 'string') {
    // if it's a URL, keep as-is
    if (isJobUrl(objOrString)) return objOrString;
    return objOrString;
  }
  const title = (guessTitle(objOrString) || '').replace(/\s+/g, ' ').trim();
  const loc = (guessLocation(objOrString) || '').replace(/\s+/g, ' ').trim();
  if (!title && isJobUrl(objOrString.url || '')) return objOrString.url;
  if (!title) return '';
  if (loc) return `${title}, ${loc}`;
  return title;
}

function writeJobsFile(lines) {
  const unique = Array.from(new Set(lines.filter(Boolean)));
  fs.writeFileSync(JOBS_FILE, unique.join(os.EOL), 'utf8');
  console.log(`Wrote ${unique.length} lines to ${JOBS_FILE}`);
}

async function main() {
  const found = [];
  // 1. JSON first
  const jpath = path.resolve(JSON_NAME);
  const cpath = path.resolve(CSV_NAME);

  const json = loadJsonIfExists(jpath);
  if (json) {
    const arr = itemsFromJson(json);
    for (const a of arr) {
      // if plain string (URL) push
      if (typeof a === 'string') {
        found.push(normalizeLine(a));
      } else {
        found.push(normalizeLine(a));
      }
    }
  }

  // 2. CSV fallback/appended
  const csvRows = loadCsvIfExists(cpath);
  if (csvRows && csvRows.length) {
    for (const r of csvRows) {
      // if row has a URL-like column, pick it first
      const urlLike = Object.values(r).find(v => isJobUrl(v));
      if (urlLike) found.push(urlLike);
      else found.push(normalizeLine(r));
    }
  }

  // 3. If neither found, exit with guidance
  if (found.length === 0) {
    console.log('No alerts found in', JSON_NAME, 'or', CSV_NAME);
    console.log('Place one of those files in repo root or continue using manual jobs.txt.');
    process.exit(0);
  }

  // write jobs.txt for downstream scripts
  writeJobsFile(found);
}

main();
