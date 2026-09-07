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

Before review, run the checks appropriate to the change and report their results.
For application changes, run:

```sh
npm run check
npm run test:e2e
```

For documentation-only changes, run `npm run test:docs` and `npm run test:policy`.
Run `npm run audit:dependencies` when dependencies or lockfiles change. Changes
to native modules, runtimes, icons, signing, or packaging also need a native build
and both packaged smoke checks described in the development guide.

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
