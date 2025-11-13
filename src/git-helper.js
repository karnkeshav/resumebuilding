// full-file: src/git-helper.js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function exec(cmd, opts = {}) {
  try {
    console.log('> ' + cmd);
    return execSync(cmd, { stdio: 'inherit', ...opts });
  } catch (err) {
    // rethrow with message for clearer logs
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
    return;
  }

  const branch = 'outbox';
  const remoteUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
  const destName = path.basename(filePath);
  const outboxDir = 'outbox';

  // ensure outbox dir exists
  if (!fs.existsSync(outboxDir)) fs.mkdirSync(outboxDir, { recursive: true });
  // copy file into outbox/
  const destPath = path.join(outboxDir, destName);
  fs.copyFileSync(filePath, destPath);
  console.log(`Copied ${filePath} -> ${destPath}`);

  // Configure git user
  try {
    exec('git config user.email "jobbot@users.noreply.github.com"');
    exec('git config user.name "jobbot[bot]"');

    // ensure remote is set to authenticated remote
    // set a temp remote named deploy-remote to avoid changing origin config
    exec(`git remote remove deploy-remote || true`);
    exec(`git remote add deploy-remote ${remoteUrl}`);

    // fetch branch if exists
    try {
      exec(`git fetch deploy-remote ${branch}`);
    } catch (e) {
      console.log(`branch ${branch} not found on remote (ok, will create)`);
    }

    // checkout a working branch (safe) and add files
    exec(`git checkout -B ${branch}`);
    exec(`git add ${outboxDir} || true`);

    // commit only if there are changes
    try {
      exec(`git diff --staged --quiet || git commit -m "Add drafted resume ${destName}"`);
    } catch (e) {
      // commit may fail if no changes; ignore
      console.log('No changes to commit or commit failed:', e.message || e);
    }

    // push to remote branch (force to ensure update)
    exec(`git push deploy-remote ${branch} --force`);
    console.log('Pushed outbox branch to remote successfully.');

    // cleanup remote
    exec('git remote remove deploy-remote || true');

    // return url for convenience
    return `https://github.com/${repo}/blob/${branch}/${encodeURIComponent(destName)}`;
  } catch (err) {
    console.error('git helper error:', err.message || err);
    throw err;
  }
}

module.exports = { commitOutbox };
