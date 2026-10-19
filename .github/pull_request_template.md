## Change

Describe the problem and resulting behavior. Link the relevant issue, if any.

## Validation

List checks actually run and their results, including
`npm run verify:pr -- --title "<actual PR title>"`. Add `--package` for native
runtime, dependency, signing, or packaging changes. Documentation-only changes
require the baseline.

Report environment or remote blockers and pending checks explicitly. Local
results do not prove the Linux/macOS/Windows CI matrix, and pull requests run
only the unit tests on macOS and Windows: note whether the complete matrix ran
(`gh workflow run ci.yml --ref <branch>`) for platform-dependent changes.
Include sanitized screenshots for visible UI changes when useful.

## Impact

Note affected data compatibility, permissions, network access, or third-party
attribution. Omit this section when none apply. Never include private data.
