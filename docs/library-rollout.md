# gh-release-notes library rollout

This integration depends on the corrected `@actionutils/gh-release-notes@0.8.0`
package. At implementation time the public registry still serves v0.7.0.

The candidate dependency lock was generated from the locally built v0.8.0
tarball; its integrity is the digest of that concrete artifact. Its final
registry URL is staged in the lock, but the package has not been published.
The committed Action distribution is built from the same candidate.

Before merging this integration:

1. Review and release the library changes in `actionutils/gh-release-notes`.
2. Run `npm install --save-exact @actionutils/gh-release-notes@0.8.0` against the
   registry to confirm or refresh its integrity.
3. Run the checks in the README and rebuild/commit `dist/`, including its WASM
   asset. Then release `create-release-pr` through its normal release flow.
4. Adopt that Action release in the other repositories. Their separate CLI-based
   note-generation and preview jobs can then be removed.

For local verification before publication, build and pack the library from the
sibling checkout, add its tarball to npm's cache with `npm cache add <tarball>`,
then run `npm ci --offline --ignore-scripts` in this repository. This tests the
lock against the candidate without claiming the version is already available
from the registry.

Provenance migration is separate from this rollout. See
[the upstream investigation](https://github.com/actionutils/gh-release-notes/blob/main/docs/release-tooling-maintenance.md)
for the SLSA generator/verifier maintenance notices and recommended migration.
