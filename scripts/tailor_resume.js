// scripts/tailor_resume.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const pdf = require('pdf-parse');
const puppeteer = require('puppeteer');
const argv = require('minimist')(process.argv.slice(2));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = process.env.GEMINI_API_URL;

if (!GEMINI_API_KEY || !GEMINI_API_URL) {
  console.error('Set GEMINI_API_KEY and GEMINI_API_URL as environment variables (GitHub secrets).');
  process.exit(1);
}

const jobTitle = argv['job-title'] || argv.jobTitle || 'Software Engineer';
const jobDesc = argv['job-desc'] || argv.jobDesc || argv['job-description'] || '';
const company = argv.company || 'Company';
const resumePath = argv['resume-path'] || 'resumes/Keshav_Resume.pdf';
const maxIterations = parseInt(argv['max-iterations'] || 1, 10) || 1;

async function extractTextFromPdf(filePath) {
  const data = fs.readFileSync(filePath);
  const res = await pdf(data);
  return res.text;
}

async function callGemini(prompt, temperature = 0.2, maxTokens = 1200) {
  // Generic POST - adapt to your provider's schema.
  const body = {
    model: "gemini-prop", // replace/model as needed
    input: prompt,
    // optional: temperature, max tokens etc.
  };

  const resp = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GEMINI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    timeout: 120000,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${text}`);
  }

  const json = await resp.json();
  // Adapt to response schema: try to find text in common fields
  // Examples: json.output_text, json.choices[0].message.content, json.result...
  if (json.output_text) return json.output_text;
  if (json.choices && json.choices[0] && json.choices[0].message) {
    return json.choices[0].message.content;
  }
  if (json.choices && json.choices[0] && json.choices[0].text) {
    return json.choices[0].text;
  }
  return JSON.stringify(json);
}

function buildTailorPrompt(resumeText, jobTitle, jobDesc) {
  return `
You are an expert resume writer. Tailor the following existing resume text to the job.

=== EXISTING RESUME TEXT START ===
${resumeText}
=== EXISTING RESUME TEXT END ===

Job title: ${jobTitle}
Job description:
${jobDesc}

Task:
1) Produce a tailored resume (in Markdown) that emphasizes relevant skills, achievements, and keywords matching the job description.
2) Keep it concise — 1-2 pages equivalent, with bullet points for responsibilities & achievements.
3) Where possible, quantify achievements (use reasonable placeholders if specific numbers are not present).
4) Use headings: Name, Contact (leave placeholder), Summary, Skills, Experience (with bullets), Education, Certifications (if any).
5) Return ONLY the resume in Markdown (no analysis).
`;
}

function buildRecruiterReviewPrompt(tailoredResumeMarkdown, company, jobTitle, jobDesc) {
  return `
You are now a recruiter at ${company} reviewing a candidate for the role: ${jobTitle}.

Job description:
${jobDesc}

Candidate tailored resume:
${tailoredResumeMarkdown}

Task:
1) As the recruiter, list up to 10 specific gaps or weaknesses where the candidate does not match the job (be explicit: missing skills, missing experience, unclear quantification, mismatched seniority).
2) For each gap, explain why it's important for this role, and give a short actionable suggestion (one sentence) on how to fix it in the resume or cover letter.
Return the response as JSON with fields: { "gaps": [ { "issue": "...", "importance": "...", "fix": "..." } ] }
`;
}

function buildFixPrompt(tailoredResumeMarkdown, gapsJson) {
  return `
You are an expert resume writer. Given the tailored resume below and the recruiter's identified gaps, update and improve the resume to address the gaps.

Tailored resume:
${tailoredResumeMarkdown}

Recruiter gaps (JSON):
${gapsJson}

Task:
1) Modify the resume to address the gaps as best as possible. If the fix requires adding quantification that is not present, add reasonable, conservative phrasing like "Led a team of X" -> "Led a small team" OR "Increased X by Y%" -> "Improved X significantly (quantified where possible)" — but mark any invented numbers with parentheses and note they should be replaced.
2) Return only the final updated resume in Markdown.
`;
}

async function saveMarkdownAsPdf(markdownText, outPdfPath, title = 'Tailored Resume') {
  const htmlTemplate = fs.readFileSync(path.join(__dirname, '..', 'templates', 'resume_template.html'), 'utf8');
  const filled = htmlTemplate.replace('{{CONTENT}}', markdownText).replace('{{TITLE}}', title);

  if (!fs.existsSync(path.join(process.cwd(), 'output'))) {
    fs.mkdirSync(path.join(process.cwd(), 'output'));
  }
  const htmlPath = path.join(process.cwd(), 'output', 'tailored_resume.html');
  fs.writeFileSync(htmlPath, filled, 'utf8');

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox']});
  const page = await browser.newPage();
  await page.setContent(filled, { waitUntil: 'networkidle0' });
  await page.pdf({ path: outPdfPath, format: 'A4', printBackground: true });
  await browser.close();
}

(async () => {
  try {
    console.log('Reading resume from', resumePath);
    const absResume = path.isAbsolute(resumePath) ? resumePath : path.join(process.cwd(), resumePath);
    if (!fs.existsSync(absResume)) {
      console.error('Resume file not found at', absResume);
      process.exit(2);
    }

    const resumeText = await extractTextFromPdf(absResume);
    console.log('Extracted resume text length:', resumeText.length);

    // 1) Tailor
    console.log('Calling Gemini to tailor resume...');
    const tailorPrompt = buildTailorPrompt(resumeText, jobTitle, jobDesc);
    const tailored = await callGemini(tailorPrompt);

    // Save intermediate
    if (!fs.existsSync('./output')) fs.mkdirSync('./output');
    fs.writeFileSync('./output/tailored_resume_stage1.md', tailored, 'utf8');

    // 2) Recruiter review
    console.log('Asking Gemini to role-play recruiter and identify gaps...');
    const reviewPrompt = buildRecruiterReviewPrompt(tailored, company, jobTitle, jobDesc);
    const gapsRaw = await callGemini(reviewPrompt);
    // We expect JSON; try to parse
    let gapsJson = gapsRaw;
    try {
      // Some LLMs return newline or code fences — extract first JSON object
      const m = gapsRaw.match(/\{[\s\S]*\}/);
      if (m) gapsJson = m[0];
      JSON.parse(gapsJson);
    } catch (e) {
      console.warn('Could not parse gaps JSON strictly; sending raw text onward.');
    }
    fs.writeFileSync('./output/recruiter_gaps.json.txt', gapsJson, 'utf8');

    // 3) Fix gaps and produce final
    console.log('Asking Gemini to fix gaps and produce final resume...');
    const fixPrompt = buildFixPrompt(tailored, gapsJson);
    const fixedResume = await callGemini(fixPrompt);

    fs.writeFileSync('./output/tailored_resume_final.md', fixedResume, 'utf8');

    // 4) Render PDF
    const outPdf = path.join(process.cwd(), 'output', 'tailored_resume_final.pdf');
    console.log('Rendering PDF to', outPdf);
    await saveMarkdownAsPdf(fixedResume, outPdf, `${jobTitle} - Tailored Resume`);

    console.log('Done. Artifacts in ./output/');
    process.exit(0);
  } catch (err) {
    console.error('ERROR', err);
    process.exit(10);
  }
})();
