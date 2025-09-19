# create-release-pr: Design Doc

## Background / Goal
- This action creates and maintains a “release Pull Request” (release PR) that, once merged, triggers other automation to bump the version and tag/release.
- It does not create tags or GitHub Releases by itself. It is meant to be used with actions such as `haya14busa/action-bumpr` that bump the version and tag when a PR with specific labels is merged.
- The release PR description shows release notes generated via GitHub’s Generate Release Notes API.

## High-Level Behavior
- Triggers:
  - `push` to the default branch (e.g., `main`).
  - `pull_request` with actions `labeled`/`unlabeled` (to react when bump labels are changed).
- Ignore condition: if the push to `main` is caused by merging the release PR created by this action, do nothing (prevent recursion).
- Behavior:
  1) Look for an existing open release PR (by head branch name, e.g., `release/pr`).
     - If found, recompute current/next tag and regenerate release notes.
     - Update the PR title and description accordingly. Do not merge the PR automatically.
  2) If not found, create a new release PR.
     - Use Generate Release Notes API output in the PR body.
     - If labels indicate the next tag, compute and show it; if not, treat “next tag” as unknown and adapt the title/body accordingly.

## Release PR Basics
- Branch strategy:
  - Default to a stable branch name `release/pr` for simplicity.
  - After the release PR is merged, handle the next cycle cleanly:
    - If the `release/pr` branch is deleted on merge (common setting), recreate it from the base branch on the next run; or
    - Optionally consider a variant like `release/pr-from-<current-tag>` for clarity (future option).
- Empty commit:
  - When there is no diff against the base, create an empty commit so a PR can be opened.
  - Achieved by creating a new commit that points to the same tree as base.
- PR body:
  - Put metadata at the top (current tag, next tag or unknown, target range, source API info).
  - Then append the raw or lightly formatted output of Generate Release Notes API.
- Title:
  - When next tag is known: `Release for <next-tag>` (e.g., `Release for v1.2.4`).
  - When unknown: `Release for new version`.
  - The action may update the title when labels change and the next tag becomes known.
- Labels:
  - Recognize `bump:major`, `bump:minor`, `bump:patch`. If present, compute next tag accordingly.
  - If no label, next tag remains “unknown”.

## Event Flow Details
- On push to main: check for existing PR → update if present → create if absent.
- On pull_request labeled/unlabeled: if the PR’s head branch matches the release branch, update title/body (recompute next tag and notes).
- Recursion guard: use the PR head branch name alone to identify the managed release PR (e.g., `release/pr`) and no-op on its merge push.

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
  - If no labels, treat “next tag” as unknown. Adapt title/body and note generation accordingly.
- Getting the current tag:
  - Use GitHub REST (`list tags` / `list matching refs`), parse `v` + SemVer, and pick the latest.

## Release Notes Generation
- API: `POST /repos/{owner}/{repo}/releases/generate-notes`.
- When next tag is known, pass it as `tag_name`.
- When unknown, treat it as unknown:
  - Prefer not to assert a concrete next tag in the PR title/body.
  - For the API, either pass a provisional name (e.g., `<prefix>next`) if required by the endpoint, or omit where supported.
- Set `target_commitish` to the default branch head (e.g., `main`).
- Include a “Full Changelog” compare link in the PR body (see template), e.g., `{repo}/compare/{current_tag}...{base_branch}` when `current_tag` exists.

## Updating Existing Release PRs
- Never auto-merge. Users explicitly merge the release PR when they want to release.
- On each trigger, recompute next tag and notes, and update title/body accordingly.
- After user merges the release PR, this action ignores the resulting push to avoid recursion and will prepare the next cycle on subsequent changes.

## Outputs
- `state`: One of:
  - `release_required` — release PR was (already) merged and a release should occur (by other automation). No open release PR exists now.
  - `pr_changed` — a release PR was created or updated in this run.
  - `pr_status_check` — status check was set on the release PR (no other changes made).
- `pr_number`: Release PR number when `state=pr_changed` or `pr_status_check`, otherwise empty.
- `pr_url`: Release PR URL when `state=pr_changed` or `pr_status_check`, otherwise empty.
- `pr_branch`: Release branch name when `state=pr_changed`, otherwise empty.
- `current_tag`: Latest parsed tag (empty if none).
- `next_tag`: When determinable; empty if unknown.
- `bump_level`: `major|minor|patch|unknown` — label-derived when available.
- `release_notes`: The generated release notes text used in the PR body.
- `status_check_state`: Status check state (`success|pending`) when `state=pr_status_check`.

## Inputs (minimal v1)
- `base-branch`: Default `main`.
- `release-branch`: Default `release/pr` (stable name; no templating in v1).
- `label-major`: Default `bump:major`.
- `label-minor`: Default `bump:minor`.
- `label-patch`: Default `bump:patch`.
- `tag-prefix`: Default `v`.
- `configuration_file_path` (optional): Path to release notes config (e.g., `.github/release.yml`).
- `github-token`: Defaults to `GITHUB_TOKEN`.

## Permissions
- `contents: write` (read commit/tag info, create branches, and required by the Generate Release Notes API)
- `pull-requests: write` (create/update PRs)
- `issues: write` (apply labels)
- `statuses: write` (set commit status checks)

## Implementation Details (Key API Steps)
1) Read context: `owner`, `repo`, `base-branch (main)`, `head-sha`, event type.
2) Recursion guard: detect own release PR by head branch name only (e.g., `release/pr`). If the push was from merging it, no-op.
3) Find existing PR: `GET /repos/{owner}/{repo}/pulls?state=open&head={owner}:{release-branch}&base={base-branch}`.
4) Determine current tag: `GET /repos/{owner}/{repo}/tags`, parse `v` + SemVer, choose latest.
5) Compute next tag: from labels on the existing PR or labels to be applied on creation.
   - If none, next tag remains unknown.
6) Generate release notes: `POST /repos/{owner}/{repo}/releases/generate-notes` with `tag_name` (definitive or provisional) and `target_commitish`.
   - If `configuration_file_path` is provided, pass it to the API.
7) Prepare release branch:
   - `GET /repos/{owner}/{repo}/git/ref/heads/{release-branch}`; if missing, create via `POST /repos/{owner}/{repo}/git/refs` from base SHA.
   - Empty commit: reuse base tree with `POST /repos/{owner}/{repo}/git/trees` → `POST /repos/{owner}/{repo}/git/commits` → update ref with `PATCH /repos/{owner}/{repo}/git/refs/heads/{release-branch}`.
8) Create/update PR:
   - Existing: regenerate title/body and `PATCH /repos/{owner}/{repo}/pulls/{pr_number}`.
   - New: `POST /repos/{owner}/{repo}/pulls`; add bump labels if desired.
9) Set outputs: PR number/URL/branch, current/next tag, flags.

## Example Body Template
```
Release prepared by create-release-pr

- Current Tag: {{ current_tag | default:"(none)" }}
- Next Tag: {{ next_tag | default:"(TBD: set bump:major/minor/patch)" }}
- Target: {{ base_branch }} @ {{ head_sha_short }}

---

{{ generated_release_notes }}

Full Changelog: https://github.com/{{ owner }}/{{ repo }}/compare/{{ current_tag }}...{{ base_branch }}
```

## Edge Cases & Considerations
- First release (no tags): `current_tag=null`; notes cover the full history; next tag is unknown unless labels are applied.
- Label changes: handled in this same workflow via `pull_request` events (`labeled`, `unlabeled`) and by checking the head branch name.
- Monorepo: path filtering or sectioned release notes are out of scope for v1 (future work).

## Example Workflow
```yaml
name: Create Release PR
on:
  push:
    branches: [ main ]
  pull_request:
    types: [ opened, synchronize, reopened, labeled, unlabeled ]
permissions: {}
jobs:
  release-pr:
    permissions:
      contents: write
      pull-requests: write
      issues: write
      statuses: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Create/Update release PR
        uses: actionutils/create-release-pr@v0
        with:
          base-branch: main
          release-branch: release/pr
          tag-prefix: v
          configuration_file_path: .github/release.yml
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Test Strategy (Minimal)
- Dry-run logging verification.
- Unit tests for next-tag computation with/without labels.
- First run in a repo with no tags.
- Existing PR present; verify PR body/title updates on label changes.

## Security
- Use minimum `GITHUB_TOKEN` permissions (explicit permissions block).
- Sanitize inputs and validate branch/label names.
- Avoid including sensitive info in commit messages/PR bodies.

## Future Work
- React to `pull_request` label changes to recalc/update body automatically.
- Infer bump from Conventional Commits (label-less mode).
- Advanced templating/sections for generated notes.
- Monorepo path-based filtering.
