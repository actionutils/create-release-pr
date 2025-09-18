# create-release-pr: Design Doc

## Background / Goal
- This action creates and maintains a “release Pull Request” (release PR) that, once merged, triggers other automation to bump the version and tag/release.
- It does not create tags or GitHub Releases by itself. It is meant to be used with actions such as `haya14busa/action-bumpr` that bump the version and tag when a PR with specific labels is merged.
- The release PR description shows release notes generated via GitHub’s Generate Release Notes API.

## High-Level Behavior
- Trigger: by default on `push` to the default branch (e.g., `main`).
- Ignore condition: if the push to `main` is caused by merging the release PR created by this action, do nothing (prevent recursion).
- Otherwise on `push` to `main`:
  1) Look for an existing release PR.
     - If found, try to “merge the existing release PR”.
       - If mergeable, auto-merge (configurable).
       - If merge is blocked/fails, just update its body and exit (see below).
  2) If not found, create a new release PR.
     - Use Generate Release Notes API output in the PR body.
     - If labels indicate the next tag, compute and display it; if not, show “next tag: unknown”.

## Release PR Basics
- Branch strategy:
  - Support either a timestamped branch like `release/<yyyy-mm-dd-hhmmss>` or a stable branch name like `release/pr`.
  - Reusing a single branch is simpler and idempotent; default to `release/pr`.
- Empty commit:
  - When there is no diff against the base, create an empty commit so a PR can be opened.
  - Achieved by creating a new commit that points to the same tree as base.
- PR body:
  - Put metadata at the top (current tag, next tag or unknown, target range, source API info).
  - Then append the raw or lightly formatted output of Generate Release Notes API.
- Title:
  - For example: `release: vX.Y.Z` or `release: next (tag TBD)`, customizable via template.
- Labels:
  - Recognize `bump:major`, `bump:minor`, `bump:patch`. If present, compute next tag accordingly.
  - If no label, next tag remains “unknown”.

## Event Flow Details
- On push to main: check for existing PR → (if present) attempt merge → (if absent) create PR.
- Recursion guard: use “List pull requests associated with a commit” for the pushed `head` commit.
  - If it is recognized as the action-managed release PR (by head branch name/title prefix/special label `release-pr`), no-op.

## Next Tag Resolution
- Assumptions:
  - Use SemVer with `v` prefix. If no tags exist, `current tag = null`.
  - Next tag is determined from labels: `major|minor|patch`.
- Algorithm:
  - Example: `current = v1.2.3`
    - `bump:major` → `v2.0.0`
    - `bump:minor` → `v1.3.0`
    - `bump:patch` → `v1.2.4`
  - If multiple labels are set, priority is major > minor > patch.
  - If no labels, next tag = unknown; reflect in PR body and outputs.
- Getting the current tag:
  - Use GitHub REST (`list tags` / `list matching refs`), parse `v` + SemVer, and pick the latest.

## Release Notes Generation
- API: `POST /repos/{owner}/{repo}/releases/generate-notes`.
- `tag_name` is required. When next tag is unknown, pass a provisional tag (e.g., `v0.0.0-next` or `next`).
  - The API generates notes based on differences from the previous tag, etc.
- `target_commitish` should be the default branch head (e.g., `main`).
- For long output, place it under a separator or collapsible section in the body template.

## Handling Existing Release PRs
- Default to auto-merge existing release PRs (`auto-merge-existing: true`).
- Merge method: `merge` by default, configurable to `squash` or `rebase`.
- If merge is blocked (required checks, permissions, etc.):
  - Do not fail the job; just update the PR body/labels and exit.
- After merge, a push to `main` happens and another action like `action-bumpr` performs the actual bump/tag.

## Outputs
- `pr_number`: Number of the created/found release PR (empty if none).
- `pr_url`: URL of the release PR.
- `pr_branch`: Release branch name.
- `current_tag`: Latest parsed tag (empty if none).
- `next_tag`: When determinable; empty if unknown.
- `has_existing_pr`: Whether an existing release PR was found.
- `merged_existing_pr`: Whether the auto-merge attempt succeeded.
- `release_notes_generated`: true/false.

## Inputs (proposed)
- `base-branch`: Default `main`.
- `release-branch`: Default `release/pr`. Supports templating (e.g., `release/${date}`).
- `title-template`: e.g., `release: {{ next_tag | default:"next" }}`.
- `body-prefix`: Arbitrary text to prepend to the PR body.
- `label-major`: Default `bump:major`.
- `label-minor`: Default `bump:minor`.
- `label-patch`: Default `bump:patch`.
- `tag-prefix`: Default `v`.
- `auto-merge-existing`: Default `true`.
- `draft`: Whether to open the PR as draft. Default `false`.
- `merge-method`: `merge|squash|rebase`. Default `merge`.
- `extra-labels`: Comma-separated list of additional labels to add on creation.
- `dry-run`: Log-only mode without mutating operations.
- `github-token`: Defaults to `GITHUB_TOKEN`; support PAT if needed.

## Permissions
- `contents: write` (read commit/tag info and create branches)
- `pull-requests: write` (create/update/merge PRs)
- `issues: write` (apply labels)

## Implementation Details (Key API Steps)
1) Read context: `owner`, `repo`, `base-branch (main)`, `head-sha`.
2) Recursion guard: `GET /repos/{owner}/{repo}/commits/{sha}/pulls`.
   - Identify own release PR by title prefix, `release-pr` label, or head branch name → no-op.
3) Find existing PR: `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:{release-branch}&base={base-branch}`.
   - If found and `auto-merge-existing=true`, try `PUT /repos/{owner}/{repo}/pulls/{pr_number}/merge`.
4) Determine current tag: `GET /repos/{owner}/{repo}/tags`, parse `v` + SemVer, choose latest.
5) Compute next tag: from labels on the existing PR or labels to be applied on creation.
   - If none, next tag remains unknown.
6) Generate release notes: `POST /repos/{owner}/{repo}/releases/generate-notes` with `tag_name` (definitive or provisional) and `target_commitish`.
7) Prepare release branch:
   - `GET /repos/{owner}/{repo}/git/ref/heads/{release-branch}`; if missing, create via `POST /repos/{owner}/{repo}/git/refs` from base SHA.
   - Empty commit: reuse base tree with `POST /repos/{owner}/{repo}/git/trees` → `POST /repos/{owner}/{repo}/git/commits` → update ref with `PATCH /repos/{owner}/{repo}/git/refs/heads/{release-branch}`.
8) Create/update PR:
   - Existing: regenerate title/body and `PATCH /repos/{owner}/{repo}/pulls/{pr_number}`.
   - New: `POST /repos/{owner}/{repo}/pulls`; add labels via `POST /issues/{pr_number}/labels`.
9) Set outputs: PR number/URL/branch, current/next tag, flags.

## Example Body Template
```
Release prepared by create-release-pr

- Current Tag: {{ current_tag | default:"(none)" }}
- Next Tag: {{ next_tag | default:"(TBD: set bump:major/minor/patch)" }}
- Target: {{ base_branch }} @ {{ head_sha_short }}

---

{{ generated_release_notes }}
```

## Edge Cases & Considerations
- First release (no tags): `current_tag=null`; notes cover the full history; next tag is unknown unless labels are applied.
- Protected branches/required checks: auto-merge may fail; in that case, only update PR content and exit.
- Label changes: the action primarily runs on `push`. If you want immediate recalculation on label changes, add a separate workflow for `pull_request` events (`labeled`, `unlabeled`) that re-runs this action or a lighter updater.
- Monorepo: path filtering or sectioned release notes are out of scope for v1 (future work).

## Example Workflow
```yaml
name: Create Release PR
on:
  push:
    branches: [ main ]
permissions:
  contents: write
  pull-requests: write
  issues: write
jobs:
  release-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Create/Update release PR
        uses: actionutils/create-release-pr@v0
        with:
          base-branch: main
          release-branch: release/pr
          auto-merge-existing: true
          title-template: 'release: {{ next_tag | default:"next" }}'
          tag-prefix: v
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Test Strategy (Minimal)
- Dry-run logging verification.
- Unit tests for next-tag computation with/without labels.
- First run in a repo with no tags.
- Existing PR present with both success/failure of auto-merge.

## Security
- Use minimum `GITHUB_TOKEN` permissions (explicit permissions block).
- Sanitize inputs and validate branch/label names.
- Avoid including sensitive info in commit messages/PR bodies.

## Future Work
- React to `pull_request` label changes to recalc/update body automatically.
- Infer bump from Conventional Commits (label-less mode).
- Advanced templating/sections for generated notes.
- Monorepo path-based filtering.
