# Repository instructions

Follow [CONTRIBUTING.md](CONTRIBUTING.md), including its English language,
commit/title, security, test-data, and attribution policies.

## Validate before publishing

Before creating or updating a PR, or pushing a PR update:

1. Inspect the relevant workflows in `.github/workflows/` and validate the actual
   final code, rerunning affected checks after subsequent changes.
2. Run `npm run verify:pr -- --title "<actual PR title>"`. The baseline always
   checks history, the title, policy tests, documentation, and all workspaces;
   documentation-only changes still require this baseline.
3. For application changes, also run with `--full`. For native runtime,
   dependency, signing, or packaging changes (including native modules and
   icons), run with both `--full --package`.
4. Fix failures before publishing. Never bypass hooks or use `--no-verify` unless
   the user explicitly authorizes it. Never remove tests or weaken CI to get
   green.

Use `--plan` to inspect commands without running them. Baseline checks may take
minutes depending on the machine. There is no changed-file selection or
caching, and local checks cannot establish the Linux/macOS/Windows CI matrix.

Install hooks in each clone with `npm run hooks:install`; the Git configuration
is normally shared with linked worktrees. Manual verification permits dirty
working trees. The pre-push hook requires clean tracked and untracked files
(ignored build outputs are allowed) and validates only the checked-out `HEAD`.
Check out other refs before pushing them. Branch deletion skips tests. The hook
runs the baseline; it does not replace required full or package verification.

## Follow through after authorized publication

Do not push or open a PR unless requested. After an authorized push or PR
creation/update, run `gh pr checks --watch` and confirm that checks correspond to
the latest pushed head SHA. Inspect failures using
`gh run view <run-id> --log-failed`, resolve failures within scope, and repeat
validation after fixes. Report remote and environment blockers accurately;
never claim checks are green while pending or blocked.
