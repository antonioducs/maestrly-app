## Change

Describe the problem and resulting behavior. Link the relevant issue, if any.

## Validation

List checks actually run and their results, including
`npm run verify:pr -- --title "<actual PR title>"`. Use `--full` for application
changes and add `--package` for native runtime, dependency, signing, or packaging
changes. Documentation-only changes require the baseline.

Report environment or remote blockers and pending checks explicitly. Local
results do not prove the Linux/macOS/Windows CI matrix. After an authorized push,
watch `gh pr checks --watch` and confirm the checks cover the latest pushed head
SHA. Include sanitized screenshots for visible UI changes when useful.

## Impact

Note affected data compatibility, permissions, network access, or third-party
attribution. Omit this section when none apply. Never include private data.
