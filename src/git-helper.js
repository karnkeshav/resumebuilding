// full-file: src/git-helper.js
const { execSync } = require('child_process');
const path = require('path');

function safeExec(cmd, opts = {}) {
  console.log('exec>', cmd);
  return execSync(cmd, { stdio: 'inherit', ...opts });
}

async function commitOutbox(filePath) {
  // expects to run inside GitHub Actions with GITHUB_TOKEN and GITHUB_REPOSITORY set
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo) {
    console.log('GITHUB_TOKEN or GITHUB_REPOSITORY not set — skipping commit.');
    return;
  }

  const branch = 'outbox';
  const remoteUrl = `https://x-access-token:${token}@github.com/${repo}.git`;

  // configure git
  safeExec('git config --global user.email "jobbot@users.noreply.github.com"');
  safeExec('git config --global user.name "jobbot[bot]"');

  // fetch & create branch if missing
  try {
    safeExec(`git fetch ${remoteUrl} ${branch}:${branch}`);
  } catch (e) {
    // branch may not exist — create orphan
    safeExec(`git checkout --orphan ${branch}`);
    safeExec('git reset --hard');
    safeExec(`git add -A`);
    safeExec('git commit -m "initial outbox" || true');
    safeExec(`git push ${remoteUrl} ${branch}`);
    safeExec('git checkout -');
  }

  // switch to branch, copy file, commit, push
  safeExec(`git checkout ${branch}`);
  const dest = path.basename(filePath);
  safeExec(`mkdir -p outbox || true`);
  safeExec(`cp -f ${filePath} outbox/${dest}`);
  safeExec('git add outbox/* || true');
  try {
    safeExec(`git commit -m "Add drafted resume ${dest}" || true`);
  } catch (e) {}
  safeExec(`git push ${remoteUrl} ${branch}`);
  safeExec('git checkout -');
}

module.exports = { commitOutbox };
