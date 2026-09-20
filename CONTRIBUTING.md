# Contributing

Keep pull requests focused. Discuss substantial features, dependencies, storage
changes, or permission changes in an issue before implementation. Follow the
[Code of Conduct](CODE_OF_CONDUCT.md); report vulnerabilities through
[SECURITY.md](SECURITY.md).

## Setup and checks

Follow [Development](docs/development.md) for prerequisites and packaging.

```sh
npm ci
npm run hooks:install
npm run dev
```

Install hooks with `npm run hooks:install` in each clone. The Git
`core.hooksPath` setting is normally shared by linked worktrees, so enabling it
also affects those worktrees. Hooks are not installed automatically by cloning.

Before review or pushing a PR update, inspect `.github/workflows/` and validate
the actual final code with the actual PR title:

```sh
npm run verify:pr -- --title "fix(desktop): handle failed startup"
```

The baseline validates repository history, the supplied title, policy tests,
documentation links, and `npm run check` across all workspaces. `--title` is
optional for manual iteration; supply the real title before creating or updating
a PR. Even documentation-only changes require the baseline. There is no
changed-file selection or caching. This baseline may still take minutes;
the verifier prints elapsed times for each step and the complete run. It sets
`CI=true` and clears external test-target overrides so local E2E does not reuse
another worktree's server or a previously packaged application.

For application changes, add `--full`:

```sh
npm run verify:pr -- --title "fix(desktop): handle failed startup" --full
```

This adds dependency auditing, the CI's pinned Gitleaks history scan, desktop E2E, real PostgreSQL integration,
platform E2E, project chat E2E, and `smoke:platform`. Install the prerequisites
required by these suites; report unavailable services or environment blockers
accurately rather than treating skipped or blocked checks as passing. The full
suite needs Go, Docker running, and Playwright Chromium installed for both web
and desktop workspaces. Headless Linux also needs Xvfb and Electron system
libraries, as configured in the CI workflows.

Changes to dependencies or lockfiles require dependency auditing. Changes to
native modules, runtimes, dependencies, icons, signing, or packaging also require
`--package` alongside `--full`:

```sh
npm run verify:pr -- --title "build(desktop): update native runtime" --full --package
```

`--package` adds the current native platform's package command: `package:linux`
on Linux (`linux`), `package:win` on Windows (`win32`), or `package` on macOS
(`darwin`), including the existing packaging smoke checks. See the development
guide for packaging prerequisites. Local verification cannot prove the complete
Linux/macOS/Windows CI matrix.

Add `--plan` to any invocation to display the commands without running them:

```sh
npm run verify:pr -- --full --package --plan
```

Manual verification supports dirty working trees for iteration. The pre-push
hook requires a clean tracked and untracked working tree (ignored build outputs
are allowed), because it must validate the actual pushed tree. It verifies only
the checked-out `HEAD`; check out any other ref before pushing it. Branch deletion
does not run tests. The hook runs the baseline; run the required full and package
checks separately before pushing.

Fix failures before pushing. Do not bypass hooks or use `--no-verify` unless the
user explicitly authorizes it; do not remove tests or weaken CI to get green.
After an authorized push or PR creation/update, run `gh pr checks --watch`,
confirm the checks cover the latest pushed head SHA, and inspect failures with
`gh run view <run-id> --log-failed`. Resolve failures within scope and report
remote or environment blockers accurately. Pending or blocked checks are not
green.

Use temporary profiles and synthetic repositories. Standard tests must not need
personal credentials or user data; live provider checks must be explicitly opt-in.
Do not commit private data, signing material, or unsanitized logs and screenshots.

## Code conventions

- Use strict TypeScript. Keep shared code independent of Electron, React, and
  Node-only APIs.
- Keep privileged operations and credential handling in the main process; validate
  renderer input there and preserve permission checks.
- Preserve durable data on failed writes and test relevant denial, failure,
  cancellation, and recovery paths.
- Use English for source, comments, tests, diagnostics, and documentation. Put
  user-facing text in the shared translation catalogs. Keep multilingual test
  inputs where they exercise localization, Unicode, or transcript compatibility.
- Document user-visible behavior, required setup, and data compatibility. Keep
  internal decision records and one-time review reports out of repository docs.
- Preserve third-party attribution and update [notices](THIRD_PARTY_NOTICES.md)
  when dependencies or derived material change.

## Pull requests

Branch from `main`. Use an English Conventional Commit subject, at most 100
characters, for commits and the PR title: `type(scope): imperative description`.
The scope is optional. Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`,
`build`, `ci`, `chore`, `revert`; use `!` for breaking changes.

Explain the problem, resulting behavior, and validation. Include compatibility,
privacy, or attribution details when affected. Resolve review threads; accepted
PRs are squash-merged after required checks pass.

Anyone may open a pull request using their own truthful Git identity. Bodies,
`Co-authored-by`, and other standard trailers are welcome when accurate.
Contributions use the repository's [MIT License](LICENSE); submit only material
you have the right to contribute.
