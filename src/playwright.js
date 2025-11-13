// full-file: src/playwright.js
const { chromium } = require('playwright');

async function fetchJob(url) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  // best-effort selectors; many sites vary — we extract full page text as fallback
  let title = '';
  try {
    title = (await page.title()) || '';
  } catch (e) { title = ''; }
  let company = '';
  // attempt common selectors
  try {
    const companyHandle = await page.$('meta[property="og:site_name"], meta[name="author"]');
    if (companyHandle) {
      company = (await companyHandle.getAttribute('content')) || '';
    }
  } catch (e) {}
  // description: try job description containers, else page body text
  let description = '';
  try {
    const selCandidates = ['.job-description', '.description', '[class*="job"]', 'article'];
    for (const s of selCandidates) {
      const el = await page.$(s);
      if (el) {
        const t = (await el.innerText()).trim();
        if (t.length > 80) { description = t; break; }
      }
    }
    if (!description) description = (await page.innerText('body')).slice(0, 20000);
  } catch (e) {
    description = '';
  }

  await browser.close();
  return { title, company, description };
}

module.exports = { fetchJob };
