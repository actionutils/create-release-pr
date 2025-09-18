// Dependency-free Node.js action (Node 20) using global fetch.
// Implements create/update of a release PR per docs/design.md.

const fs = require('fs');

async function run() {
  try {
    const token = input('github-token') || process.env.GITHUB_TOKEN;
    if (!token) throw new Error('Missing github-token');

    const repoFull = process.env.GITHUB_REPOSITORY || '';
    const [owner, repo] = repoFull.split('/');
    if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);

    const baseBranch = input('base-branch') || 'main';
    const releaseBranch = input('release-branch') || 'release/pr';
    const labelMajor = input('label-major') || 'bump:major';
    const labelMinor = input('label-minor') || 'bump:minor';
    const labelPatch = input('label-patch') || 'bump:patch';
    const tagPrefix = input('tag-prefix') || 'v';
    const releaseCfgPath = input('configuration_file_path') || undefined;

    const eventName = process.env.GITHUB_EVENT_NAME;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const event = eventPath && fs.existsSync(eventPath) ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {};

    const gh = makeClient(token, owner, repo);

    if (eventName === 'pull_request') {
      const action = event.action;
      if (action !== 'labeled' && action !== 'unlabeled') return setOutputs({ state: 'noop' });
      const pr = event.pull_request;
      if (!pr) return setOutputs({ state: 'noop' });
      if (pr.head && pr.head.ref !== releaseBranch) return setOutputs({ state: 'noop' });
      // Update this release PR based on labels.
      const currentTag = await latestTag(gh, tagPrefix).catch(() => null);
      const bumpLevel = detectBump(pr.labels || [], { labelMajor, labelMinor, labelPatch });
      const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
      const notes = await generateNotes(gh, {
        tagName: nextTag || `${tagPrefix}next`,
        target: baseBranch,
        configuration_file_path: releaseCfgPath,
      }).catch(() => '');
      const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
      await gh.patch(`/repos/${owner}/${repo}/pulls/${pr.number}`, { title, body });
      return setOutputs({
        state: 'pr_changed',
        pr_number: String(pr.number),
        pr_url: pr.html_url,
        pr_branch: releaseBranch,
        current_tag: currentTag || '',
        next_tag: nextTag || '',
        bump_level: bumpLevel,
        release_notes: notes,
      });
    }

    if (eventName === 'push') {
      // Recursion guard: if this push is a merge of our release PR, mark release_required and exit.
      const headSha = event.after;
      let associated = [];
      try {
        associated = await gh.get(`/repos/${owner}/${repo}/commits/${headSha}/pulls`);
      } catch (_) {
        associated = [];
      }
      const relPR = associated.find(p => p.head && p.head.ref === releaseBranch);
      if (relPR) {
        const currentTag = await latestTag(gh, tagPrefix).catch(() => null);
        const bumpLevel = detectBump(relPR.labels || [], { labelMajor, labelMinor, labelPatch });
        const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
        return setOutputs({
          state: 'release_required',
          pr_number: '',
          pr_url: '',
          pr_branch: '',
          current_tag: currentTag || '',
          next_tag: nextTag || '',
          bump_level: bumpLevel,
          release_notes: '',
        });
      }

      // Otherwise, create or update the release PR.
      const currentTag = await latestTag(gh, tagPrefix).catch(() => null);
      const existing = await findOpenReleasePR(gh, { owner, repo, baseBranch, releaseBranch }).catch(() => null);

      let prNumber, prUrl;
      if (existing && existing.number) {
        const bumpLevel = detectBump(existing.labels || [], { labelMajor, labelMinor, labelPatch });
        const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
        const notes = await generateNotes(gh, {
          tagName: nextTag || `${tagPrefix}next`,
          target: baseBranch,
          configuration_file_path: releaseCfgPath,
        }).catch(() => '');
        const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
        const updated = await gh.patch(`/repos/${owner}/${repo}/pulls/${existing.number}`, { title, body });
        prNumber = String(updated.number);
        prUrl = updated.html_url;
        return setOutputs({
          state: 'pr_changed',
          pr_number: prNumber,
          pr_url: prUrl,
          pr_branch: releaseBranch,
          current_tag: currentTag || '',
          next_tag: nextTag || '',
          bump_level: bumpLevel,
          release_notes: notes,
        });
      }

      // Ensure release branch exists and is ahead by one empty commit.
      await ensureReleaseBranch(gh, { baseBranch, releaseBranch });
      // Create PR
      const bumpLevel = 'unknown';
      const nextTag = '';
      const notes = await generateNotes(gh, {
        tagName: `${tagPrefix}next`,
        target: baseBranch,
        configuration_file_path: releaseCfgPath,
      }).catch(() => '');
      const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
      const created = await gh.post(`/repos/${owner}/${repo}/pulls`, {
        title,
        head: releaseBranch,
        base: baseBranch,
        body,
        draft: false,
      });
      prNumber = String(created.number);
      prUrl = created.html_url;
      return setOutputs({
        state: 'pr_changed',
        pr_number: prNumber,
        pr_url: prUrl,
        pr_branch: releaseBranch,
        current_tag: currentTag || '',
        next_tag: nextTag || '',
        bump_level: bumpLevel,
        release_notes: notes,
      });
    }

    // Other events: noop
    return setOutputs({ state: 'noop' });
  } catch (err) {
    coreError(String(err && err.stack || err));
    process.exit(1);
  }
}

function input(name) {
  const k = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return process.env[k];
}

function setOutputs(map) {
  const outPath = process.env.GITHUB_OUTPUT;
  const lines = [];
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined) continue;
    lines.push(`${k}=${escapeNewlines(String(v))}`);
  }
  if (outPath) fs.appendFileSync(outPath, lines.join('\n') + '\n');
  // Also log for visibility
  console.log('Outputs:\n' + lines.map(l => '  ' + l).join('\n'));
}

function coreError(msg) {
  console.error(`::error::${msg}`);
}

function makeClient(token, owner, repo) {
  const base = 'https://api.github.com';
  async function request(method, path, body) {
    const url = path.startsWith('http') ? path : base + path;
    const res = await fetch(url, {
      method,
      headers: {
        'authorization': `Bearer ${token}`,
        'accept': 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'actionutils-create-release-pr'
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return res.text();
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
  };
}

async function latestTag(gh, prefix) {
  // Fetch tags and pick latest SemVer with given prefix.
  const tags = await gh.get(`/repos/${ghOwnerRepo()}/tags?per_page=100`);
  const semvers = (tags || []).map(t => t.name).filter(n => n && n.startsWith(prefix)).map(n => ({ name: n, v: parseSemVer(n.slice(prefix.length)) }))
    .filter(x => x.v).sort((a, b) => cmpSemVer(a.v, b.v));
  return semvers.length ? semvers[semvers.length - 1].name : null;

  function ghOwnerRepo() {
    return process.env.GITHUB_REPOSITORY;
  }
}

function parseSemVer(s) {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function cmpSemVer(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function detectBump(labels, cfg) {
  const names = new Set((labels || []).map(l => typeof l === 'string' ? l : l.name));
  if (names.has(cfg.labelMajor)) return 'major';
  if (names.has(cfg.labelMinor)) return 'minor';
  if (names.has(cfg.labelPatch)) return 'patch';
  return 'unknown';
}

function calcNext(prefix, currentTag, bumpLevel) {
  const cur = currentTag && currentTag.startsWith(prefix) ? parseSemVer(currentTag.slice(prefix.length)) : { major: 0, minor: 0, patch: 0 };
  if (!cur) throw new Error(`Current tag is not SemVer with prefix: ${currentTag}`);
  let { major, minor, patch } = cur;
  if (bumpLevel === 'major') { major += 1; minor = 0; patch = 0; }
  else if (bumpLevel === 'minor') { minor += 1; patch = 0; }
  else if (bumpLevel === 'patch') { patch += 1; }
  return `${prefix}${major}.${minor}.${patch}`;
}

async function generateNotes(gh, { tagName, target, configuration_file_path }) {
  const body = { tag_name: tagName, target_commitish: target };
  if (configuration_file_path) body.configuration_file_path = configuration_file_path;
  const res = await gh.post(`/repos/${process.env.GITHUB_REPOSITORY}/releases/generate-notes`, body);
  return res.body || '';
}

async function findOpenReleasePR(gh, { owner, repo, baseBranch, releaseBranch }) {
  const prs = await gh.get(`/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(owner + ':' + releaseBranch)}`);
  return Array.isArray(prs) && prs.length ? prs[0] : null;
}

async function ensureReleaseBranch(gh, { baseBranch, releaseBranch }) {
  // Check ref
  let ref;
  try {
    ref = await gh.get(`/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/${encodeURIComponent(releaseBranch)}`);
    if (ref && ref.object && ref.object.sha) {
      // Already exists; nothing more to do.
      return;
    }
  } catch (_) {
    // missing
  }
  const baseRef = await gh.get(`/repos/${process.env.GITHUB_REPOSITORY}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef.object.sha;
  const baseCommit = await gh.get(`/repos/${process.env.GITHUB_REPOSITORY}/git/commits/${baseSha}`);
  const treeSha = baseCommit.tree.sha;
  // Create empty commit that points to the same tree, with parent = baseSha
  const newCommit = await gh.post(`/repos/${process.env.GITHUB_REPOSITORY}/git/commits`, {
    message: 'chore(release): prepare release PR (empty commit)',
    tree: treeSha,
    parents: [baseSha],
  });
  const newSha = newCommit.sha;
  // Create ref pointing to new commit
  await gh.post(`/repos/${process.env.GITHUB_REPOSITORY}/git/refs`, {
    ref: `refs/heads/${releaseBranch}`,
    sha: newSha,
  });
}

function buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes }) {
  const known = !!nextTag;
  const title = known ? `Release for ${nextTag}` : 'Release for new version';
  const parts = [];
  parts.push('Release prepared by create-release-pr');
  parts.push('');
  parts.push(`- Current Tag: ${currentTag || '(none)'}`);
  parts.push(`- Next Tag: ${nextTag || '(TBD: set bump:major/minor/patch)'}`);
  parts.push(`- Target: ${baseBranch}`);
  parts.push('');
  parts.push('---');
  parts.push('');
  if (notes) parts.push(notes);
  if (currentTag) parts.push(`\nFull Changelog: https://github.com/${owner}/${repo}/compare/${currentTag}...${baseBranch}`);
  return { title, body: parts.join('\n') };
}

run();

