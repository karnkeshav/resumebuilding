// full-file: src/git-helper.js
// Robust helper to commit Markdown drafts into outbox/ on the outbox branch.
// - Runs in GitHub Actions with GITHUB_TOKEN and GITHUB_REPOSITORY set.
// - Avoids copying a file onto itself, ensures outbox exists in the branch,
//   and uses safe checkout behavior (git checkout -B outbox).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function exec(cmd, opts = {}) {
  try {
    console.log('exec>', cmd);
    return execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    const e = new Error(`Command failed: ${cmd}\n${err.message}`);
    e.original = err;
    throw e;
  }
}

async function commitOutbox(filePath) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log('GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping commit.');
    return null;
  }

  const branch = 'outbox';
  const remoteUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const outboxDir = 'outbox';
  const destName = path.basename(filePath);
  const destPath = path.join(outboxDir, destName);

  // ensure local outbox exists so copy will succeed if needed
  if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });

  // copy only if source and destination are different paths
  const srcResolved = path.resolve(filePath);
  const destResolved = path.resolve(destPath);
  if (srcResolved !== destResolved) {
    try {
      fs.copyFileSync(srcResolved, destResolved);
      console.log(`Copied ${srcResolved} -> ${destResolved}`);
    } catch (e) {
      // if copy fails, surface as error
      throw new Error(`Copy failed: ${e && e.message ? e.message : e}`);
    }
  } else {
    console.log('Source file already inside outbox; skipping copy.');
  }

  try {
    // configure git identity
    exec('git config user.email "jobbot@users.noreply.github.com"');
    exec('git config user.name "jobbot[bot]"');

    // add an authenticated temporary remote
    exec('git remote remove deploy-remote || true');
    exec(`git remote add deploy-remote ${remoteUrl}`);

    // fetch remote branch (if exists) without trying to map to local branch directly
    try {
      exec(`git fetch deploy-remote ${branch}`);
    } catch (e) {
      console.log(`Remote branch ${branch} may not exist yet; will create locally.`);
    }

    // checkout (create-or-reset) the outbox branch locally
    exec(`git checkout -B ${branch}`);

    // ensure folder exists inside checked-out branch
    exec(`mkdir -p ${outboxDir}`);

    // add only markdown files inside outbox
    exec(`git add ${outboxDir}/*.md || true`);

    // commit staged changes (only if any)
    try {
      exec('git diff --staged --quiet || git commit -m "Add drafted resume ' + destName + '"');
    } catch (e) {
      console.log('No staged changes to commit or commit failed:', e && e.message ? e.message : e);
    }

    // push to remote branch (force to make sure branch is updated)
    exec(`git push deploy-remote ${branch} --force`);
    console.log('Pushed outbox branch to remote successfully.');

    // clean up remote
    exec('git remote remove deploy-remote || true');

    // return a convenient file URL (best-effort)
       return `https://github.com/${repo}/blob/${branch}/outbox/${encodeURIComponent(destName)}`;
  } catch (err) {
    console.error('git helper error:', err && err.message ? err.message : err);
    // attempt cleanup
    try { exec('git remote remove deploy-remote || true'); } catch (e) {}
    throw err;
  }
}

module.exports = { commitOutbox };
