// TypeScript source of the action. The compiled output is committed in dist/index.js.
// This action creates/updates a release PR and exposes outputs as per docs/design.md.

import { readFileSync, existsSync } from 'fs';
import * as core from '@actions/core';

type BumpLevel = 'major' | 'minor' | 'patch' | 'unknown';

type GhClient = {
  get: <T = any>(path: string) => Promise<T>;
  post: <T = any>(path: string, body?: any) => Promise<T>;
  patch: <T = any>(path: string, body?: any) => Promise<T>;
  put: <T = any>(path: string, body?: any) => Promise<T>;
  del: <T = any>(path: string) => Promise<T>;
};

async function run(): Promise<void> {
  try {
    const token = (core.getInput('github-token') || process.env.GITHUB_TOKEN) as string | undefined;
    if (!token) throw new Error('Missing github-token');

    const repoFull = process.env.GITHUB_REPOSITORY || '';
    const [owner, repo] = repoFull.split('/');
    if (!owner || !repo) throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);

    const baseBranch = core.getInput('base-branch') || 'main';
    const releaseBranch = core.getInput('release-branch') || 'release/pr';
    const labelMajor = core.getInput('label-major') || 'bump:major';
    const labelMinor = core.getInput('label-minor') || 'bump:minor';
    const labelPatch = core.getInput('label-patch') || 'bump:patch';
    const tagPrefix = core.getInput('tag-prefix') || 'v';
    const releaseCfgPath = core.getInput('configuration_file_path') || undefined;

    const eventName = process.env.GITHUB_EVENT_NAME;
    const eventPath = process.env.GITHUB_EVENT_PATH;
    const event = eventPath && existsSync(eventPath) ? JSON.parse(readFileSync(eventPath, 'utf8')) : {} as any;

    const gh = makeClient(token);

    if (eventName === 'pull_request') {
      const action = (event as any).action;
      if (action !== 'labeled' && action !== 'unlabeled') { core.setOutput('state', 'noop'); return; }
      const pr = (event as any).pull_request;
      if (!pr) { core.setOutput('state', 'noop'); return; }
      if (pr.head && pr.head.ref !== releaseBranch) { core.setOutput('state', 'noop'); return; }
      const currentTag = await latestTag(gh, owner, repo, tagPrefix).catch(() => null);
      const bumpLevel = detectBump(pr.labels || [], { labelMajor, labelMinor, labelPatch });
      const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
      const notes = await generateNotes(gh, owner, repo, {
        tagName: nextTag || `${tagPrefix}next`,
        target: baseBranch,
        configuration_file_path: releaseCfgPath,
      }).catch(() => '');
      const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
      await gh.patch(`/repos/${owner}/${repo}/pulls/${pr.number}`, { title, body });
      core.setOutput('state', 'pr_changed');
      core.setOutput('pr_number', String(pr.number));
      core.setOutput('pr_url', pr.html_url);
      core.setOutput('pr_branch', releaseBranch);
      core.setOutput('current_tag', currentTag || '');
      core.setOutput('next_tag', nextTag || '');
      core.setOutput('bump_level', bumpLevel);
      core.setOutput('release_notes', notes);
      return;
    }

    if (eventName === 'push') {
      const headSha: string = (event as any).after;
      let associated: any[] = [];
      try {
        associated = await gh.get(`/repos/${owner}/${repo}/commits/${headSha}/pulls`);
      } catch {
        associated = [];
      }
      const relPR = associated.find(p => p.head && p.head.ref === releaseBranch);
      if (relPR) {
        const currentTag = await latestTag(gh, owner, repo, tagPrefix).catch(() => null);
        const bumpLevel = detectBump(relPR.labels || [], { labelMajor, labelMinor, labelPatch });
        const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
        core.setOutput('state', 'release_required');
        core.setOutput('pr_number', '');
        core.setOutput('pr_url', '');
        core.setOutput('pr_branch', '');
        core.setOutput('current_tag', currentTag || '');
        core.setOutput('next_tag', nextTag || '');
        core.setOutput('bump_level', bumpLevel);
        core.setOutput('release_notes', '');
        return;
      }

      const currentTag = await latestTag(gh, owner, repo, tagPrefix).catch(() => null);
      const existing = await findOpenReleasePR(gh, { owner, repo, baseBranch, releaseBranch }).catch(() => null);

      if (existing && existing.number) {
        const bumpLevel = detectBump(existing.labels || [], { labelMajor, labelMinor, labelPatch });
        const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
        const notes = await generateNotes(gh, owner, repo, {
          tagName: nextTag || `${tagPrefix}next`,
          target: baseBranch,
          configuration_file_path: releaseCfgPath,
        }).catch(() => '');
        const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
        const updated = await gh.patch(`/repos/${owner}/${repo}/pulls/${existing.number}`, { title, body });
        core.setOutput('state', 'pr_changed');
        core.setOutput('pr_number', String(updated.number));
        core.setOutput('pr_url', updated.html_url);
        core.setOutput('pr_branch', releaseBranch);
        core.setOutput('current_tag', currentTag || '');
        core.setOutput('next_tag', nextTag || '');
        core.setOutput('bump_level', bumpLevel);
        core.setOutput('release_notes', notes);
        return;
      }

      await ensureReleaseBranch(gh, owner, repo, { baseBranch, releaseBranch });
      const bumpLevel: BumpLevel = 'unknown';
      const nextTag = '';
      const notes = await generateNotes(gh, owner, repo, {
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
      core.setOutput('state', 'pr_changed');
      core.setOutput('pr_number', String(created.number));
      core.setOutput('pr_url', created.html_url);
      core.setOutput('pr_branch', releaseBranch);
      core.setOutput('current_tag', currentTag || '');
      core.setOutput('next_tag', nextTag || '');
      core.setOutput('bump_level', bumpLevel);
      core.setOutput('release_notes', notes);
      return;
    }

    core.setOutput('state', 'noop');
    return;
  } catch (err: any) {
    core.setFailed(String(err?.stack || err));
    process.exit(1);
  }
}
function makeClient(token: string): GhClient {
  const base = 'https://api.github.com';
  async function request<T>(method: string, path: string, body?: any): Promise<T> {
    const url = path.startsWith('http') ? path : base + path;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'actionutils-create-release-pr',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return (await res.json()) as T;
    return (await res.text()) as any as T;
  }
  return {
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
  };
}

async function latestTag(gh: GhClient, owner: string, repo: string, prefix: string): Promise<string | null> {
  const tags = await gh.get<any[]>(`/repos/${owner}/${repo}/tags?per_page=100`);
  const semvers = (tags || [])
    .map(t => t.name as string)
    .filter(n => n && n.startsWith(prefix))
    .map(n => ({ name: n, v: parseSemVer(n.slice(prefix.length)) }))
    .filter((x): x is { name: string; v: SemVer } => !!x.v)
    .sort((a, b) => cmpSemVer(a.v, b.v));
  return semvers.length ? semvers[semvers.length - 1].name : null;
}

type SemVer = { major: number; minor: number; patch: number };
function parseSemVer(s: string): SemVer | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function cmpSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function detectBump(labels: any[], cfg: { labelMajor: string; labelMinor: string; labelPatch: string }): BumpLevel {
  const names = new Set((labels || []).map(l => typeof l === 'string' ? l : l.name));
  if (names.has(cfg.labelMajor)) return 'major';
  if (names.has(cfg.labelMinor)) return 'minor';
  if (names.has(cfg.labelPatch)) return 'patch';
  return 'unknown';
}

function calcNext(prefix: string, currentTag: string | null, bumpLevel: BumpLevel): string {
  const cur = currentTag && currentTag.startsWith(prefix)
    ? parseSemVer(currentTag.slice(prefix.length))
    : { major: 0, minor: 0, patch: 0 };
  if (!cur) throw new Error(`Current tag is not SemVer with prefix: ${currentTag}`);
  let { major, minor, patch } = cur;
  if (bumpLevel === 'major') { major += 1; minor = 0; patch = 0; }
  else if (bumpLevel === 'minor') { minor += 1; patch = 0; }
  else if (bumpLevel === 'patch') { patch += 1; }
  return `${prefix}${major}.${minor}.${patch}`;
}

async function generateNotes(
  gh: GhClient,
  owner: string,
  repo: string,
  { tagName, target, configuration_file_path }: { tagName: string; target: string; configuration_file_path?: string }
): Promise<string> {
  const body: any = { tag_name: tagName, target_commitish: target };
  if (configuration_file_path) body.configuration_file_path = configuration_file_path;
  const res = await gh.post<{ body?: string }>(`/repos/${owner}/${repo}/releases/generate-notes`, body);
  return res.body || '';
}

async function findOpenReleasePR(
  gh: GhClient,
  { owner, repo, baseBranch, releaseBranch }: { owner: string; repo: string; baseBranch: string; releaseBranch: string }
) {
  const prs = await gh.get<any[]>(`/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(owner + ':' + releaseBranch)}`);
  return Array.isArray(prs) && prs.length ? prs[0] : null;
}

async function ensureReleaseBranch(
  gh: GhClient,
  owner: string,
  repo: string,
  { baseBranch, releaseBranch }: { baseBranch: string; releaseBranch: string }
) {
  try {
    const ref = await gh.get<any>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(releaseBranch)}`);
    if (ref && ref.object && ref.object.sha) return; // exists
  } catch {}
  const baseRef = await gh.get<any>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
  const baseSha = baseRef.object.sha as string;
  const baseCommit = await gh.get<any>(`/repos/${owner}/${repo}/git/commits/${baseSha}`);
  const treeSha = baseCommit.tree.sha as string;
  const newCommit = await gh.post<any>(`/repos/${owner}/${repo}/git/commits`, {
    message: 'chore(release): prepare release PR (empty commit)',
    tree: treeSha,
    parents: [baseSha],
  });
  const newSha = newCommit.sha as string;
  await gh.post(`/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/${releaseBranch}`,
    sha: newSha,
  });
}

function buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes }: { owner: string; repo: string; baseBranch: string; currentTag: string | null; nextTag: string; notes: string; }) {
  const known = !!nextTag;
  const title = known ? `Release for ${nextTag}` : 'Release for new version';
  const parts: string[] = [];
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
