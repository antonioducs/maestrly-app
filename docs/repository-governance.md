# Repository Governance

This document records the contribution and default-branch policy for
`antonioducs/maestrly-app`. Repository settings are operational controls;
versioned workflows and the ruleset payload make those controls reviewable.

## Merge policy

Changes target `main` through a focused pull request. Repository merge settings
must keep:

- squash merge as the only merge method;
- the pull-request title as the squash commit subject, with no generated body;
- merge commits and rebase merge disabled;
- review threads resolved before merge;
- branch deletion after merge; and
- no force push or deletion of `main`.

Zero approving reviews are required during the single-maintainer phase, but a
pull request and successful checks are still required. This preserves an auditable
change description without inventing a second reviewer.

Anyone may open a pull request from their own GitHub account and with their own
truthful Git identity. Only maintainers with repository permission can merge.
Transport credentials, automation, and review roles never justify rewriting a
contributor's author or committer identity.

An administrator can apply the merge and community settings above without
changing repository visibility:

```sh
gh api --method PATCH repos/antonioducs/maestrly-app \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true \
  -F has_discussions=true \
  -f squash_merge_commit_title=PR_TITLE \
  -f squash_merge_commit_message=BLANK

gh api --method PUT repos/antonioducs/maestrly-app/topics \
  -f 'names[]=electron' \
  -f 'names[]=react' \
  -f 'names[]=typescript' \
  -f 'names[]=ai' \
  -f 'names[]=local-first' \
  -f 'names[]=orchestration' \
  -f 'names[]=mcp' \
  -f 'names[]=developer-tools'
```

Read the settings back after applying them:

```sh
gh api repos/antonioducs/maestrly-app \
  --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, delete_branch_on_merge, has_discussions, squash_merge_commit_title, squash_merge_commit_message, topics}'
```

## Required checks

The `main` ruleset requires these stable GitHub Actions contexts:

| Check | Workflow | Guarantee |
| --- | --- | --- |
| `Linux` | CI | Lockfile install, history policy, aggregate check, Electron suite |
| `macOS` | CI | Lockfile install, history policy, aggregate check, Electron suite |
| `Windows` | CI | Lockfile install, history policy, aggregate check, Electron suite |
| `Dependency policy` | Security | No new, stale, malformed, or expired advisory exception |
| `Secret history` | Security | Full Git history passes pinned Gitleaks |

The scheduled `Package smoke` workflow is deliberately not a pull-request gate.
It builds target-native packages and runs packaged desktop/Local ML smokes on
Linux, macOS, and Windows. These jobs are slower, consume external runtime
downloads, and validate packaging rather than ordinary source review.

CodeQL default setup runs separately. Its check is not required by the ruleset
until the project has observed a stable context and reviewed its false-positive
and platform behavior.

## Immutable automation

Third-party GitHub Actions are pinned to full commit SHAs with a human-readable
version comment. Repository-policy tests reject mutable tags. Dependabot proposes
grouped minor/patch updates for npm and Actions with a bounded pull-request count.

Provider/runtime packages listed in `.github/dependabot.yml` are upgraded only
in focused changes because their versions are coupled to registries, integrity
data, downloaded executables, or protocol tests.

## Dependency exceptions

`npm run audit:dependencies` checks production and development dependencies.
An accepted finding must match the exact package, installed path, GHSA identifier,
rationale, and unexpired review date in
`config/npm-audit-allowlist.json`. A resolved advisory makes its old exception
stale and fails the check until the exception is removed.

Exceptions are temporary risk records, not wildcard suppressions. Updating an
expiry requires a new review of upstream availability, reachability, and local
mitigations.

## Package and release boundary

Ordinary package workflows never upload or publish `dist`. Checked-in
electron-builder configurations disable publication, and the wrapper adds
`--publish never`. Ad-hoc and scheduled CI packages prove build/runtime
behavior only.

The tag-only `Release` workflow is the separate publication boundary. It
copies only verified distributables into `.release-local-staging`, transfers
them between native jobs as short-lived workflow artifacts, and grants
`contents: write` only to the final draft-publication job. Signed supported
releases follow [releasing.md](releasing.md).

## Versioned ruleset

The applied REST payload lives at [.github/rulesets/main.json](../.github/rulesets/main.json).
It targets the default branch, has no bypass actors, requires pull requests and
linear squash history, prevents deletion/force pushes, and names the five checks
above.

Before replacing or reapplying the ruleset, an administrator must verify
capability and ensure no duplicate ruleset exists:

```sh
gh api repos/antonioducs/maestrly-app/rulesets
gh api repos/antonioducs/maestrly-app/rulesets \
  --jq '[.[] | select(.name == "Protect main")] | length'
```

Proceed only when the second command prints `0`, all five check contexts have
completed successfully at least once, and `gh api user --jq .login` identifies an
authorized administrator. Then apply the reviewed payload:

```sh
gh api --method POST repos/antonioducs/maestrly-app/rulesets \
  --input .github/rulesets/main.json
```

Read the created ruleset back and compare every rule and required context with
the committed JSON. Never leave the public default branch unintentionally
unprotected.

## Release environments and secrets

The `release` environment is restricted to tag deployments matching `v*`.
It has no required reviewer during the single-maintainer phase and does not make
its secrets available to pull-request workflows. Its expected configuration is:

```sh
jq -n '{
  wait_timer: 0,
  can_admins_bypass: true,
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true
  }
}' | gh api --method PUT repos/antonioducs/maestrly-app/environments/release --input -

gh api --method POST \
  repos/antonioducs/maestrly-app/environments/release/deployment-branch-policies \
  -f name='v*' \
  -f type=tag
```

The environment holds exactly the six Apple signing/notarization secret names
documented in [releasing.md](releasing.md). Values must never be added to
repository variables, files, logs, issues, pull requests, or chat. GitHub does
not expose existing secret values, so they must be provisioned independently
for this repository.

The workflow uses read-only permissions until all native jobs pass. It creates a
draft through the GitHub CLI, verifies downloaded checksums, and only then
publishes it. Code-signing material lives in a temporary keychain and
`RUNNER_TEMP` and is removed by an unconditional cleanup step.
