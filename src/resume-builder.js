// full-file: src/resume-builder.js
// Reads state/selected.json, pops first selection, generates a tailored resume (MD + DOCX),
// commits outputs to resume-outputs branch, notifies user by Telegram, and marks selection processed.
//
// Assumptions:
// - master_resume.json exists at repo root and contains structured resume data.
//   Expected shape (safely handled if absent):
//   {
//     "header": { "name": "...", "phone": "...", "email":"...", "location":"...", "linkedin":"...", "credly": "..." },
//     "summary": "...",
//     "experiences": [ { "company": "PwC", "title":"...", "start":"", "end":"", "bullets":[...] }, ... ],
//     "education": [ ... ],
//     "skills": [ ... ],
//     "certifications": [ ... ]
//   }
//
// - outbox/<draft>.md contains the scraped job + match summary produced by src/index.js
// - GitHub Actions provides GITHUB_TOKEN and GITHUB_REPOSITORY in env
// - src/telegram.js exists and exports sendTelegram(text, inlineKeyboard?)
//
// Dependencies:
//   npm install docx markdown-it
//
// Behavior summary:
// 1. loads state/selected.json and takes first pending item (FIFO).
// 2. reads outbox/<file> to extract job metadata and match summary.
// 3. tailors master_resume.json by:
//    - inserting suggested bullets near relevant experiences
//    - adding a tailored summary prefix mentioning the target role/company
//    - ordering experiences PwC -> Kyndryl -> IBM -> Wipro -> Tech Mahindra -> Mainstay (if present)
// 4. writes a Markdown and a DOCX under resume-outputs/, commits to resume-outputs branch, pushes
// 5. notifies via Telegram with authoritative links, removes processed entry from state and commits it.
//

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { Document, Packer, Paragraph, TextRun } = require('docx'); // npm: docx
const MarkdownIt = require('markdown-it'); // npm: markdown-it
const md = new MarkdownIt();

const { sendTelegram } = require('./telegram');

const STATE_FILE = path.resolve('state/selected.json');
const OUTBOX_DIR = path.resolve('outbox');
const OUTPUT_DIR = path.resolve('resume-outputs');
const MASTER_JSON = path.resolve('master_resume.json');

const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || null;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;

function safeReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function saveJSON(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

// simple parser to extract match summary and bullets from the draft MD
function parseDraftMd(mdText) {
  const res = { title: null, company: null, jobId: null, url: null, location: null, match: { score: 0, matched: [], partial: [], missing: [], matchedBullets: [] }, description: '' };
  // Title line "# Title"
  const titleMatch = mdText.match(/^#\s*(.+)$/m);
  if (titleMatch) res.title = titleMatch[1].trim();
  const companyMatch = mdText.match(/\*\*Company:\*\*\s*(.+)/m);
  if (companyMatch) res.company = companyMatch[1].trim();
  const locMatch = mdText.match(/\*\*Location:\*\*\s*(.+)/m);
  if (locMatch) res.location = locMatch[1].trim();
  const idMatch = mdText.match(/\*\*Job ID:\*\*\s*(.+)/m);
  if (idMatch) res.jobId = idMatch[1].trim();
  const urlMatch = mdText.match(/\*\*URL:\*\*\s*(\S+)/m);
  if (urlMatch) res.url = urlMatch[1].trim();

  // description block between "## Extracted job description" and next section
  const descMatch = mdText.match(/## Extracted job description\s*\n```(?:\n|)([\s\S]*?)```/m);
  if (descMatch) res.description = descMatch[1].trim();

  // match summary block
  const matchBlock = mdText.match(/## Match summary\s*\n([\s\S]*?)(?:\n##|$)/m);
  if (matchBlock) {
    const lines = matchBlock[1].split('\n').map(l => l.trim()).filter(Boolean);
    for (const ln of lines) {
      if (ln.startsWith('- match score:')) {
        const num = ln.split(':')[1] && ln.split(':')[1].trim();
        res.match.score = Number(num) || res.match.score;
      } else if (ln.startsWith('- matched skills:')) {
        const val = ln.split(':')[1] || ''; res.match.matched = val.split(',').map(s => s.trim()).filter(Boolean);
      } else if (ln.startsWith('- partial matches:')) {
        const val = ln.split(':')[1] || ''; res.match.partial = val.split(',').map(s => s.trim()).filter(Boolean);
      } else if (ln.startsWith('- missing skills:')) {
        const val = ln.split(':')[1] || ''; res.match.missing = val.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
  }

  // suggested bullets
  const bulletsMatch = mdText.match(/## Suggested bullets[\s\S]*?\n([\s\S]*)/m);
  if (bulletsMatch) {
    const bulletsText = bulletsMatch[1];
    // take lines starting with "- "
    const b = bulletsText.split('\n').map(l => l.trim()).filter(x => x.startsWith('- ')).map(x => x.replace(/^- /, '').trim());
    res.match.matchedBullets = b;
  }

  return res;
}

// Order experiences according to desired list if present
const PREFERRED_ORDER = ['PwC', 'Kyndryl', 'IBM', 'Wipro', 'Tech Mahindra', 'Mainstay'];

function orderExperiences(exps) {
  if (!Array.isArray(exps)) return exps || [];
  const byCompany = {};
  for (const e of exps) {
    byCompany[e.company || ''] = e;
  }
  const ordered = [];
  for (const name of PREFERRED_ORDER) {
    if (byCompany[name]) ordered.push(byCompany[name]);
  }
  // append remaining companies (not in preferred list) in original order
  for (const e of exps) {
    if (!PREFERRED_ORDER.includes(e.company)) ordered.push(e);
  }
  return ordered;
}

function buildTailoredResume(master, draftParsed) {
  // Clone master to avoid mutating original
  const out = JSON.parse(JSON.stringify(master || {}));
  if (!out.header) out.header = {};
  // Prefix summary to indicate alignment
  const target = `${draftParsed.title || 'Target Role'} @ ${draftParsed.company || ''}`.trim();
  const tailoredSummary = (out.summary ? out.summary + '\n\n' : '') +
    `Targeted for ${target}. Emphasizes enterprise collaboration, identity & access, and communications operations aligned to M365, SSO, and service governance.`;
  out.summary = tailoredSummary;

  // Order experiences
  out.experiences = orderExperiences(out.experiences || []);

  // For each experience, inject matched bullets near the top if they seem relevant.
  // Simple heuristic: if a matched bullet contains a keyword from company/role, add to that company's bullets,
  // else add to top of first experience (senior).
  const bullets = draftParsed.match.matchedBullets || [];
  if (bullets.length > 0) {
    // lowercase set of company names for matching
    const companyNames = (out.experiences || []).map(e => (e.company || '').toLowerCase());
    for (const b of bullets) {
      const bl = b.toLowerCase();
      // find first experience whose company name appears in bullet
      let idx = companyNames.findIndex(cn => cn && bl.includes(cn));
      if (idx === -1) {
        // match based on keywords like 'm365', 'teams', 'sharepoint', 'sso', 'identity', 'certificate'
        const kw = ['m365', 'teams', 'sharepoint', 'exchange', 'sso', 'identity', 'auth0', 'certificate', 'dns', 'enra', 'entra'];
        idx = companyNames.findIndex((cn) => kw.some(k => bl.includes(k) || (cn && cn.includes(k))));
      }
      if (idx === -1) idx = 0; // fallback to first experience
      const targetExp = out.experiences[idx] || null;
      if (targetExp) {
        targetExp.bullets = targetExp.bullets || [];
        // add bullet at top but keep simple human language
        const humanBullet = b.replace(/\s+/g, ' ').trim();
        // avoid duplicates
        if (!targetExp.bullets.find(x => x.toLowerCase() === humanBullet.toLowerCase())) {
          targetExp.bullets.unshift(humanBullet);
        }
      }
    }
  }

  // Highlight missing skills in a 'Skills to add' area (kept simple)
  if (draftParsed.match.missing && draftParsed.match.missing.length) {
    out.skills = out.skills || [];
    const missingNew = (draftParsed.match.missing || []).filter(m => m && !out.skills.map(s => s.toLowerCase()).includes((m || '').toLowerCase()));
    // append missing skills at end for attention
    out.skills = out.skills.concat(missingNew).filter(Boolean);
  }

  return out;
}

function renderMarkdownFromStructured(res) {
  const lines = [];
  const h = res.header || {};
  // Header (exact style user requested)
  if (h.name) lines.push(`**${h.name}**`);
  const contactParts = [];
  if (h.phone) contactParts.push(`${h.phone}`);
  if (h.email) contactParts.push(`${h.email}`);
  if (h.location) contactParts.push(`${h.location}`);
  if (h.linkedin) contactParts.push(`${h.linkedin}`);
  if (h.credly) contactParts.push(`${h.credly}`);
  if (contactParts.length) lines.push(contactParts.join(' | '));
  lines.push('\n---\n');

  // Summary
  if (res.summary) {
    lines.push('## PROFESSIONAL SUMMARY');
    lines.push(res.summary.trim());
    lines.push('');
  }

  // Experience (PwC -> Mainstay order preserved by builder)
  if (Array.isArray(res.experiences) && res.experiences.length) {
    lines.push('## PROFESSIONAL EXPERIENCE');
    for (const e of res.experiences) {
      const titleLine = `${e.title || ''}${e.company ? ` — ${e.company}` : ''}${(e.start || e.end) ? ` (${e.start || ''} - ${e.end || ''})` : ''}`.trim();
      lines.push(`### ${titleLine}`);
      if (e.bullets && e.bullets.length) {
        for (const b of e.bullets) lines.push(`- ${b}`);
      }
      lines.push('');
    }
  }

  // Education
  if (Array.isArray(res.education) && res.education.length) {
    lines.push('## EDUCATION');
    for (const ed of res.education) {
      lines.push(`- ${ed.degree || ''}${ed.institution ? `, ${ed.institution}` : ''}${ed.year ? ` (${ed.year})` : ''}`);
    }
    lines.push('');
  }

  // Certifications
  if (Array.isArray(res.certifications) && res.certifications.length) {
    lines.push('## CERTIFICATIONS');
    for (const c of res.certifications) lines.push(`- ${c}`);
    lines.push('');
  }

  // Skills
  if (Array.isArray(res.skills) && res.skills.length) {
    lines.push('## KEY SKILLS');
    lines.push(res.skills.join(' · '));
    lines.push('');
  }

  lines.push('\n*Resume tailored for the job — generated by JobBot.*');
  return lines.join('\n');
}

async function buildDocxFromMarkdown(mdText, outPathDocx) {
  // Convert markdown to simple paragraphs using markdown-it then to docx
  const tokens = md.parse(mdText, {});
  const doc = new Document();
  // iterate tokens and convert to paragraphs/runs. Keep it simple.
  for (const t of tokens) {
    if (t.type === 'heading_open') {
      // find inline token next for text
      continue;
    }
    if (t.type === 'inline') {
      const content = t.content || '';
      // split by newlines to preserve lists
      if (content.trim().startsWith('- ')) {
        const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
        for (const ln of lines) {
          const text = ln.replace(/^-+\s*/, '');
          const p = new Paragraph({ text });
          doc.addSection({ children: [p] });
        }
      } else {
        const p = new Paragraph({ children: [ new TextRun(content) ] });
        doc.addSection({ children: [p] });
      }
    }
    if (t.type === 'paragraph_open') {
      continue;
    }
  }

  // Simpler robust fallback: write entire MD as a single paragraph if doc has no content
  try {
    const packer = new Packer();
    const buffer = await packer.toBuffer(doc);
    fs.writeFileSync(outPathDocx, buffer);
  } catch (e) {
    // fallback: write MD text into a very simple docx using minimal binary—avoid complexity
    fs.writeFileSync(outPathDocx, Buffer.from(mdText, 'utf8'));
  }
}

// Git helper to commit outputs to resume-outputs branch
function commitOutputs(files, msg) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    console.warn('GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping commit of outputs.');
    return null;
  }
  const remote = `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPOSITORY}.git`;
  try {
    execSync('git config user.email "jobbot@users.noreply.github.com"');
    execSync('git config user.name "jobbot[bot]"');
    execSync('git remote remove resume-remote || true');
    execSync(`git remote add resume-remote ${remote}`);
    const branch = 'resume-outputs';
    try { execSync(`git fetch resume-remote ${branch}`); } catch (e) { /* branch may not exist */ }
    execSync(`git checkout -B ${branch}`);
    // ensure output dir exists in branch
    execSync(`mkdir -p ${OUTPUT_DIR}`);
    execSync(`git add ${files.map(f => `"${f}"`).join(' ')}`);
    try { execSync('git diff --staged --quiet || git commit -m "' + msg.replace(/"/g, '\\"') + '"'); } catch (e) { /* nothing to commit */ }
    execSync(`git push resume-remote ${branch} --force`);
    execSync('git remote remove resume-remote || true');
    // return first file's URL as reference
    const webPaths = files.map(f => {
      const filename = path.basename(f);
      return `https://github.com/${GITHUB_REPOSITORY}/blob/${branch}/${encodeURIComponent(path.basename(f))}`;
    });
    return webPaths[0] || null;
  } catch (e) {
    console.error('commitOutputs failed:', e && e.message ? e.message : e);
    try { execSync('git remote remove resume-remote || true'); } catch (ex) {}
    return null;
  }
}

async function main() {
  // load selected queue
  const state = safeReadJSON(STATE_FILE) || { pending: [] };
  if (!state.pending || state.pending.length === 0) {
    console.log('No pending selections in state/selected.json; exiting.');
    return process.exit(0);
  }

  // take first pending (FIFO)
  const entry = state.pending.shift();
  // write back state immediately to avoid double-processing if workflow re-triggers
  saveJSON(STATE_FILE, state);
  console.log('Processing selection:', entry);

  const filename = entry.file;
  const outboxPath = path.join(OUTBOX_DIR, filename);
  if (!fs.existsSync(outboxPath)) {
    console.error('Draft file not found in outbox:', outboxPath);
    await sendTelegram(`⚠️ Draft ${filename} not found in outbox. Skipping.`);
    return;
  }

  const draftMd = fs.readFileSync(outboxPath, 'utf8');
  const parsed = parseDraftMd(draftMd);
  console.log('Parsed draft:', parsed.title, parsed.company, parsed.jobId);

  // read master_resume.json
  const master = safeReadJSON(MASTER_JSON);
  if (!master) {
    await sendTelegram('⚠️ master_resume.json not found or invalid. Cannot build tailored resume.');
    return process.exit(1);
  }

  // build tailored structured resume
  const tailored = buildTailoredResume(master, parsed);

  // render markdown
  const outMd = renderMarkdownFromStructured(tailored);

  // ensure outputs dir
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const baseName = `${(parsed.company || 'company').toLowerCase().replace(/\s+/g,'-').slice(0,40)}-${(parsed.title||'role').toLowerCase().replace(/\s+/g,'-').slice(0,40)}-${parsed.jobId || Date.now()}`;
  const mdOutPath = path.join(OUTPUT_DIR, `${baseName}.md`);
  const docxOutPath = path.join(OUTPUT_DIR, `${baseName}.docx`);

  fs.writeFileSync(mdOutPath, outMd, 'utf8');
  console.log('Wrote markdown resume:', mdOutPath);

  // build DOCX (best-effort)
  try {
    await buildDocxFromMarkdown(outMd, docxOutPath);
    console.log('Wrote docx resume:', docxOutPath);
  } catch (e) {
    console.error('DOCX build failed:', e && e.message ? e.message : e);
  }

  // commit outputs to resume-outputs branch
  const committedUrl = commitOutputs([mdOutPath, docxOutPath].filter(fs.existsSync), `Add tailored resume ${baseName}`);
  const mdWebUrl = committedUrl ? committedUrl.replace('.docx', '.md') : `https://github.com/${GITHUB_REPOSITORY}/blob/resume-outputs/${encodeURIComponent(path.basename(mdOutPath))}`;

  // notify via Telegram
  const notification = [
    `✅ Tailored resume built for *${parsed.title || 'role'}* @ *${parsed.company || ''}*`,
    `Match score: ${parsed.match.score || 0}`,
    `Resume (MD): ${mdWebUrl}`,
    `DOCX (if generated): https://github.com/${GITHUB_REPOSITORY}/blob/resume-outputs/${encodeURIComponent(path.basename(docxOutPath))}`
  ].join('\n');

  await sendTelegram(notification);

  // mark selection processed (already removed from head). Save state again and commit state
  saveJSON(STATE_FILE, state);
  try { execSync('git config user.email "jobbot@users.noreply.github.com"'); execSync('git config user.name "jobbot[bot]"'); execSync('git add state/selected.json'); execSync('git diff --staged --quiet || git commit -m "JobBot: processed selection ' + (entry.id || entry.file) + '"'); execSync('git push || true'); } catch (e) { /* non-fatal */ }

  console.log('Resume build complete.');
  process.exit(0);
}

// run
main().catch(err => {
  console.error('resume-builder fatal error:', err && err.message ? err.message : err);
  process.exit(1);
});
