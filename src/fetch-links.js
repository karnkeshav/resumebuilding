// full-file: src/fetch-links.js
// Converts search lines in jobs.txt (or search terms) into LinkedIn /jobs/view/ links.
// Used after alerts-reader.js which writes jobs.txt (one search or URL per line).

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const JOBS_FILE = 'jobs.txt';
const OUT_FILE = 'jobs.txt'; // overwrite with discovered view links
const MAX_PER_SEARCH = 6;

function buildSearchUrl(line) {
  const parts = line.split(',').map(p => p.trim()).filter(Boolean);
  const keywords = parts[0] || '';
  const location = parts[1] || '';
  const q = encodeURIComponent(keywords);
  const loc = encodeURIComponent(location);
  let url = `https://www.linkedin.com/jobs/search/?keywords=${q}`;
  if (loc) url += `&location=${loc}`;
  return url;
}

async function getLinksFromSearch(searchUrl, limit = MAX_PER_SEARCH) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
  const hrefs = await page.$$eval('a[href*="/jobs/view/"]', els =>
    Array.from(new Set(els.map(e => e.href.split('?')[0])))
  );
  await browser.close();
  return hrefs.slice(0, limit);
}

async function main() {
  if (!fs.existsSync(JOBS_FILE)) {
    console.log('jobs.txt not found. Nothing to expand.');
    process.exit(0);
  }

  const lines = fs.readFileSync(JOBS_FILE, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);

  const discovered = [];
  for (const line of lines) {
    if (line.includes('/jobs/view/')) {
      if (!discovered.includes(line)) discovered.push(line);
      continue;
    }
    const searchUrl = buildSearchUrl(line);
    console.log('Searching LinkedIn for:', line);
    try {
      const links = await getLinksFromSearch(searchUrl, MAX_PER_SEARCH);
      for (const l of links) {
        if (!discovered.includes(l)) discovered.push(l);
      }
    } catch (e) {
      console.error('Error fetching', searchUrl, e && e.message ? e.message : e);
    }
  }

  if (discovered.length === 0) {
    console.log('No job view links discovered.');
    process.exit(0);
  }

  fs.writeFileSync(OUT_FILE, discovered.join('\n'), 'utf8');
  console.log(`Wrote ${discovered.length} discovered job URLs to ${OUT_FILE}`);
}

main();
