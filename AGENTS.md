# Repository instructions

Follow [CONTRIBUTING.md](CONTRIBUTING.md), including its English language,
commit/title, security, test-data, and attribution policies.

## Validate before publishing

Before creating or updating a PR, or pushing a PR update:

1. Inspect the relevant workflows in `.github/workflows/` and validate the actual
   final code, rerunning affected checks after subsequent changes.
2. Commit, then run `npm run verify:pr -- --title "<actual PR title>"`. The
   baseline always checks history, the title, policy tests, documentation, and
   all workspaces; documentation-only changes still require this baseline. A
   run that passes with no pending files lets the pre-push hook skip that exact
   commit instead of repeating the checks.
3. Do not run `--full` routinely: CI runs desktop E2E and the mobile web flows
   on Linux, the dependency audit, and the Gitleaks scan on every PR. Use it to
   reproduce a failure of those suites. For native runtime, dependency, signing,
   or packaging changes (including native modules and icons), also run with
   `--package`.
4. Pull requests run only the unit tests on macOS and Windows; `main` runs every
   suite there. For changes that depend on macOS or Windows behavior (paths,
   shells, native APIs, packaging), run the complete matrix on the branch with
   `gh workflow run ci.yml --ref <branch>` and wait for it before merging.
5. Fix failures before publishing. Never bypass hooks or use `--no-verify` unless
   the user explicitly authorizes it. Never remove tests or weaken CI to get
   green.

Use `--plan` to inspect commands without running them. Baseline checks may take
minutes depending on the machine. There is no changed-file selection, and local
checks cannot establish the Linux/macOS/Windows CI matrix.

Install hooks in each clone with `npm run hooks:install`; the Git configuration
is normally shared with linked worktrees. Manual verification permits dirty
working trees. The pre-push hook requires clean tracked and untracked files
(ignored build outputs are allowed) and validates only the checked-out `HEAD`.
Check out other refs before pushing them. Branch deletion skips tests. The hook
runs the baseline unless that commit already passed it; it does not replace
required package verification.

## Follow through after authorized publication

Do not push or open a PR unless requested. When you open a PR, enable
auto-merge with `gh pr merge --auto --squash` unless the user wants to review
it first or asked for a draft: GitHub squash-merges it once the required checks
pass. Report the PR with its checks pending; you need not watch them. If
auto-merge is unavailable, say so and follow the procedure below.

Without auto-merge, or when asked to follow the checks, run
`gh pr checks --watch` after an authorized push or PR creation/update and
confirm that checks correspond to the latest pushed head SHA. Inspect failures
using `gh run view <run-id> --log-failed`, resolve failures within scope, and
repeat validation after fixes. Report remote and environment blockers
accurately; never claim checks are green while pending or blocked.

A failed `main` run, where macOS and Windows run their E2E, needs a prompt fix
or revert of the change that caused it.
