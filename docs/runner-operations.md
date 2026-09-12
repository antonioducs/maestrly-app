# Runner operations

For graphical setup with connected accounts, subscriptions, skills, MCPs and persistent conversations, use the [Maestrly desktop executor](desktop-executor.md). The optional CLI below is a Node process without Electron or a display server.

```bash
npm run build:protocol
npm run build:sdk
npm run build --workspace @maestrly/runner-core
npm run build:runner
node apps/runner/dist/cli.js enroll --url https://maestrly.example --organization ORG_ID --token ONE_USE_TOKEN
node apps/runner/dist/cli.js doctor
node apps/runner/dist/cli.js run
```

`enroll` exchanges a short-lived, one-use authorization for a revocable machine credential. The credential file is mode `0600` where supported. The runner never copies desktop sessions; configure `OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` explicitly for the service account used by this machine.

`doctor` checks instance protocol negotiation, machine identity, local storage, declared capabilities, and the configured isolation engine without executing a card. A runner advertises only Codex non-interactive, Claude Agent SDK, and patch delivery in this release.

The default lease is 60 seconds and renews every 15 seconds. If renewal cannot be confirmed before the safety margin, the executor is cancelled and cleanup is awaited. On restart, the local journal is reconciled before another claim. A matching PID alone is never treated as proof that a process belongs to an old execution.

Use `status` for the server-visible state and `revoke` to invalidate the machine credential. The desktop can remain active after closing its window when **Continue in background** is enabled. Quitting the desktop stops its executor; the CLI has its own independent lifecycle.

## Isolation

Codex runs with its explicit `workspace-write` OS sandbox in a disposable clone. Claude Agent SDK enables its native sandbox with `failIfUnavailable`, denies home access, and uses a strict provider-domain network allowlist. The container helper emits a read-only, capability-dropped, network-disabled Docker invocation and never mounts the host home, filesystem root, or Docker socket. Operators must validate any executor image before selecting it. A Git worktree or clone is file organization, not a security boundary.

Provider-backed tests are opt-in and require dedicated credentials. Deterministic CI tests do not prove provider availability or billing behavior.

## Approved repositories

Use `repository --binding REPOSITORY_ID --path /absolute/checkout --branch main` to register a local checkout in the runner configuration. The command validates Git and the requested branch. Restart the runner after registration. Each claim advertises the available local branches; jobs with an unavailable repository or branch remain queued for a compatible runner.

The job snapshot selects the branch. The disposable checkout is detached at its base commit, and evidence includes that commit plus a patch suitable for review. Patch collection uses separate trusted Git metadata rather than the executor's mutable Git config and index.

See [Kanban workflows](kanban-workflows.md) for project, policy and desktop setup.

## Column automation capabilities

Start the runner with its own provider credentials. Codex model discovery intersects the installed CLI's bundled capability catalog with the API account's model list. Claude uses the SDK's model metadata (including effort and fast support). Credentials are not sent to the Maestrly server. Missing credentials or an unavailable runtime produce a visible catalog issue; models are not invented in the web UI.

The runner publishes its model catalog and supported modes during claim polling. After changing credentials or runtime configuration, restart it. Use **Refresh runners** in the column editor to read the latest published catalog.

```bash
node apps/runner/dist/cli.js configure --codex-path /absolute/path/to/codex --command-image maestrly/runner-executor:local
node apps/runner/dist/cli.js doctor
node apps/runner/dist/cli.js run
```

Pre-commands require Docker and an explicitly provisioned local image containing `/bin/sh` and the needed tools. Images are never pulled during execution. The command runs with a read-only image, no network, no host credentials, dropped capabilities, bounded resources and only the disposable workspace mounted writable. Install dependencies in the image or provide them through the approved repository; network-dependent setup commands fail explicitly. The embedded desktop runner uses `MAESTRLY_COMMAND_IMAGE` for the equivalent optional image.

Standard mode can execute directly or enable bounded Maestrly-owned delegation. Maestro uses the existing desktop strategy guidance and resource specialties for planning, delegated work, integration and independent review. Work sharing one checkout is serialized. Review/exploration runs have read-only tools or filesystem permissions. Native provider subagents are suppressed; Maestrly owns stage IDs, permissions, cancellation and evidence. A failed required review is reported as failure/needs-attention, not as completed work.

Timeout spans workspace preparation, pre-commands and agent stages. It cancels the active process or container. Log limits are enforced before publishing events, with an explicit truncation event. Run details expose execution logs and the Maestro stage receipt.

## Developer computers

Use [personal devices](personal-devices.md) for a developer's own computer. The desktop's **Maestrly executor → Only me** mode creates a user-owned device, excluded from the shared runner pool. Web requests choose the device per execution. Shared headless runners and column defaults continue to serve team automation.
