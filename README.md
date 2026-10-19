# create-release-pr

Create and maintain a draft release PR. Choose a version with a `bump:major`,
`bump:minor`, or `bump:patch` label, then merge the PR when ready. Separate release
automation creates tags and GitHub Releases.

## Release notes

The integration on this branch uses the `@actionutils/gh-release-notes` npm
library directly. It pins the unreleased v0.8.0 candidate; publish that package
and refresh the dependency lock from the registry before merging this integration
or releasing this Action. Local validation uses the built candidate tarball.

Notes are generated for the repository and base branch managed by the Action.
Configuration is read from that repository at the target ref, in this order:

1. `.github/release-drafter.yml`
2. `.github/release.yml`
3. `.github/release.yaml`

Without a configuration file, GitHub-style default notes are generated. Set
`configuration_file_path` to choose a different repository file. A checkout is
not needed for repository configuration; local MiniJinja templates and
`.changelog/` includes require a checkout of the desired source.

```yaml
- uses: actions/checkout@v5
- uses: actionutils/create-release-pr@v0
  id: release-pr
  with:
    configuration_file_path: .github/release.yml
    # Optional: local file, HTTPS URL, or GitHub purl.
    release-notes-template: .github/release-notes.md.jinja
```

The template receives the same data as
[`gh-release-notes --json`](https://github.com/actionutils/gh-release-notes#templates-and-output).
The generated Markdown is used in the release PR and returned in
`release_notes`, so a downstream release job can publish the same notes.

`skip-release-notes: 'true'` omits notes from the PR description while retaining
the generated `release_notes` output, as before.
If generation fails, the Action retains its existing warning-and-empty-notes
behavior so PR management can continue. Optional sponsor-page scraping is
disabled for this integration.

## Inputs and outputs

See [action.yml](action.yml) for all inputs and outputs. Existing bump-label,
branch naming, configuration, and `release_notes` output names are retained.
The optional `release-notes-template` input adds MiniJinja rendering.

The generator only needs repository and pull request read access. The Action
still needs write permissions for the PRs, labels, branches, and commit statuses
it manages; replacing note generation does not remove those permissions.

## Development

Use Node.js 24 and `npm ci`. Run `npm run lint`, `npm run format:check`,
`npm run typecheck`, `npm test`, and `npm run build`. Commit the generated `dist/`
files, including the MiniJinja WASM asset. The test suite bundles the integration
with ncc and exercises template rendering so missing runtime assets are detected.

See [the design document](docs/design.md) for the release PR lifecycle.
