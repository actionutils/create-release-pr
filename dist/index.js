"use strict";
// TypeScript source of the action. The compiled output is committed in dist/index.js.
// This action creates/updates a release PR and exposes outputs as per docs/design.md.
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
function run() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const token = input('github-token') || process.env.GITHUB_TOKEN;
            if (!token)
                throw new Error('Missing github-token');
            const repoFull = process.env.GITHUB_REPOSITORY || '';
            const [owner, repo] = repoFull.split('/');
            if (!owner || !repo)
                throw new Error(`Invalid GITHUB_REPOSITORY: ${repoFull}`);
            const baseBranch = input('base-branch') || 'main';
            const releaseBranch = input('release-branch') || 'release/pr';
            const labelMajor = input('label-major') || 'bump:major';
            const labelMinor = input('label-minor') || 'bump:minor';
            const labelPatch = input('label-patch') || 'bump:patch';
            const tagPrefix = input('tag-prefix') || 'v';
            const releaseCfgPath = input('configuration_file_path') || undefined;
            const eventName = process.env.GITHUB_EVENT_NAME;
            const eventPath = process.env.GITHUB_EVENT_PATH;
            const event = eventPath && (0, fs_1.existsSync)(eventPath) ? JSON.parse((0, fs_1.readFileSync)(eventPath, 'utf8')) : {};
            const gh = makeClient(token);
            if (eventName === 'pull_request') {
                const action = event.action;
                if (action !== 'labeled' && action !== 'unlabeled')
                    return setOutputs({ state: 'noop' });
                const pr = event.pull_request;
                if (!pr)
                    return setOutputs({ state: 'noop' });
                if (pr.head && pr.head.ref !== releaseBranch)
                    return setOutputs({ state: 'noop' });
                const currentTag = yield latestTag(gh, owner, repo, tagPrefix).catch(() => null);
                const bumpLevel = detectBump(pr.labels || [], { labelMajor, labelMinor, labelPatch });
                const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
                const notes = yield generateNotes(gh, owner, repo, {
                    tagName: nextTag || `${tagPrefix}next`,
                    target: baseBranch,
                    configuration_file_path: releaseCfgPath,
                }).catch(() => '');
                const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
                yield gh.patch(`/repos/${owner}/${repo}/pulls/${pr.number}`, { title, body });
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
                const headSha = event.after;
                let associated = [];
                try {
                    associated = yield gh.get(`/repos/${owner}/${repo}/commits/${headSha}/pulls`);
                }
                catch (_a) {
                    associated = [];
                }
                const relPR = associated.find(p => p.head && p.head.ref === releaseBranch);
                if (relPR) {
                    const currentTag = yield latestTag(gh, owner, repo, tagPrefix).catch(() => null);
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
                const currentTag = yield latestTag(gh, owner, repo, tagPrefix).catch(() => null);
                const existing = yield findOpenReleasePR(gh, { owner, repo, baseBranch, releaseBranch }).catch(() => null);
                if (existing && existing.number) {
                    const bumpLevel = detectBump(existing.labels || [], { labelMajor, labelMinor, labelPatch });
                    const nextTag = bumpLevel === 'unknown' ? '' : calcNext(tagPrefix, currentTag, bumpLevel);
                    const notes = yield generateNotes(gh, owner, repo, {
                        tagName: nextTag || `${tagPrefix}next`,
                        target: baseBranch,
                        configuration_file_path: releaseCfgPath,
                    }).catch(() => '');
                    const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
                    const updated = yield gh.patch(`/repos/${owner}/${repo}/pulls/${existing.number}`, { title, body });
                    return setOutputs({
                        state: 'pr_changed',
                        pr_number: String(updated.number),
                        pr_url: updated.html_url,
                        pr_branch: releaseBranch,
                        current_tag: currentTag || '',
                        next_tag: nextTag || '',
                        bump_level: bumpLevel,
                        release_notes: notes,
                    });
                }
                yield ensureReleaseBranch(gh, owner, repo, { baseBranch, releaseBranch });
                const bumpLevel = 'unknown';
                const nextTag = '';
                const notes = yield generateNotes(gh, owner, repo, {
                    tagName: `${tagPrefix}next`,
                    target: baseBranch,
                    configuration_file_path: releaseCfgPath,
                }).catch(() => '');
                const { title, body } = buildPRText({ owner, repo, baseBranch, currentTag, nextTag, notes });
                const created = yield gh.post(`/repos/${owner}/${repo}/pulls`, {
                    title,
                    head: releaseBranch,
                    base: baseBranch,
                    body,
                    draft: false,
                });
                return setOutputs({
                    state: 'pr_changed',
                    pr_number: String(created.number),
                    pr_url: created.html_url,
                    pr_branch: releaseBranch,
                    current_tag: currentTag || '',
                    next_tag: nextTag || '',
                    bump_level: bumpLevel,
                    release_notes: notes,
                });
            }
            return setOutputs({ state: 'noop' });
        }
        catch (err) {
            coreError(String((err === null || err === void 0 ? void 0 : err.stack) || err));
            process.exit(1);
        }
    });
}
function input(name) {
    const k = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
    return process.env[k];
}
function setOutputs(map) {
    const outPath = process.env.GITHUB_OUTPUT;
    const lines = [];
    for (const [k, v] of Object.entries(map)) {
        if (v === undefined)
            continue;
        lines.push(`${k}=${escapeNewlines(String(v))}`);
    }
    if (outPath)
        (0, fs_1.appendFileSync)(outPath, lines.join('\n') + '\n');
    console.log('Outputs:\n' + lines.map(l => '  ' + l).join('\n'));
}
function escapeNewlines(s) {
    if (!s.includes('\n'))
        return s;
    return `<<EOF\n${s}\nEOF`;
}
function coreError(msg) {
    console.error(`::error::${msg}`);
}
function makeClient(token) {
    const base = 'https://api.github.com';
    function request(method, path, body) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = path.startsWith('http') ? path : base + path;
            const res = yield fetch(url, {
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
                const text = yield res.text().catch(() => '');
                throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
            }
            const ct = res.headers.get('content-type') || '';
            if (ct.includes('application/json'))
                return (yield res.json());
            return (yield res.text());
        });
    }
    return {
        get: (p) => request('GET', p),
        post: (p, b) => request('POST', p, b),
        patch: (p, b) => request('PATCH', p, b),
        put: (p, b) => request('PUT', p, b),
        del: (p) => request('DELETE', p),
    };
}
function latestTag(gh, owner, repo, prefix) {
    return __awaiter(this, void 0, void 0, function* () {
        const tags = yield gh.get(`/repos/${owner}/${repo}/tags?per_page=100`);
        const semvers = (tags || [])
            .map(t => t.name)
            .filter(n => n && n.startsWith(prefix))
            .map(n => ({ name: n, v: parseSemVer(n.slice(prefix.length)) }))
            .filter((x) => !!x.v)
            .sort((a, b) => cmpSemVer(a.v, b.v));
        return semvers.length ? semvers[semvers.length - 1].name : null;
    });
}
function parseSemVer(s) {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!m)
        return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}
function cmpSemVer(a, b) {
    if (a.major !== b.major)
        return a.major - b.major;
    if (a.minor !== b.minor)
        return a.minor - b.minor;
    return a.patch - b.patch;
}
function detectBump(labels, cfg) {
    const names = new Set((labels || []).map(l => typeof l === 'string' ? l : l.name));
    if (names.has(cfg.labelMajor))
        return 'major';
    if (names.has(cfg.labelMinor))
        return 'minor';
    if (names.has(cfg.labelPatch))
        return 'patch';
    return 'unknown';
}
function calcNext(prefix, currentTag, bumpLevel) {
    const cur = currentTag && currentTag.startsWith(prefix)
        ? parseSemVer(currentTag.slice(prefix.length))
        : { major: 0, minor: 0, patch: 0 };
    if (!cur)
        throw new Error(`Current tag is not SemVer with prefix: ${currentTag}`);
    let { major, minor, patch } = cur;
    if (bumpLevel === 'major') {
        major += 1;
        minor = 0;
        patch = 0;
    }
    else if (bumpLevel === 'minor') {
        minor += 1;
        patch = 0;
    }
    else if (bumpLevel === 'patch') {
        patch += 1;
    }
    return `${prefix}${major}.${minor}.${patch}`;
}
function generateNotes(gh_1, owner_1, repo_1, _a) {
    return __awaiter(this, arguments, void 0, function* (gh, owner, repo, { tagName, target, configuration_file_path }) {
        const body = { tag_name: tagName, target_commitish: target };
        if (configuration_file_path)
            body.configuration_file_path = configuration_file_path;
        const res = yield gh.post(`/repos/${owner}/${repo}/releases/generate-notes`, body);
        return res.body || '';
    });
}
function findOpenReleasePR(gh_1, _a) {
    return __awaiter(this, arguments, void 0, function* (gh, { owner, repo, baseBranch, releaseBranch }) {
        const prs = yield gh.get(`/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(owner + ':' + releaseBranch)}`);
        return Array.isArray(prs) && prs.length ? prs[0] : null;
    });
}
function ensureReleaseBranch(gh_1, owner_1, repo_1, _a) {
    return __awaiter(this, arguments, void 0, function* (gh, owner, repo, { baseBranch, releaseBranch }) {
        try {
            const ref = yield gh.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(releaseBranch)}`);
            if (ref && ref.object && ref.object.sha)
                return; // exists
        }
        catch (_b) { }
        const baseRef = yield gh.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
        const baseSha = baseRef.object.sha;
        const baseCommit = yield gh.get(`/repos/${owner}/${repo}/git/commits/${baseSha}`);
        const treeSha = baseCommit.tree.sha;
        const newCommit = yield gh.post(`/repos/${owner}/${repo}/git/commits`, {
            message: 'chore(release): prepare release PR (empty commit)',
            tree: treeSha,
            parents: [baseSha],
        });
        const newSha = newCommit.sha;
        yield gh.post(`/repos/${owner}/${repo}/git/refs`, {
            ref: `refs/heads/${releaseBranch}`,
            sha: newSha,
        });
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
    if (notes)
        parts.push(notes);
    if (currentTag)
        parts.push(`\nFull Changelog: https://github.com/${owner}/${repo}/compare/${currentTag}...${baseBranch}`);
    return { title, body: parts.join('\n') };
}
run();
