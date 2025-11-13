# JobBot (GitHub Actions starter)

This repo runs on GitHub Actions to:
- read `jobs.txt`
- fetch job pages with Playwright
- extract keywords and match against `master_resume.json`
- produce a draft markdown resume in `outbox/` (committed to branch `outbox`)
- notify you via Telegram

Secrets required in GitHub repo Settings → Actions → Secrets:
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID
- GITHUB_TOKEN (provided automatically in Actions)

Run locally: `npm ci` then `npm start` (Playwright browsers require `npx playwright install`).
