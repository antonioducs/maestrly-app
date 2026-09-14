# Shared accounts and direct creation

An account has one persistent authority on a Host. Bots store its public account ID,
model and effort. The Electron main process keeps a public directory of accounts and
registered Hosts; renderer state and operation journals never contain refresh tokens.
Each authority starts pinned native Codex 0.153.4 in an exclusive private HOME and
CODEX_HOME, exposes authentication/model operations only, and supervises process recovery.
Credential files use private permissions and durable writes. No development profile is used.

Managed Linux workers use Codex's `chatgptAuthTokens` login with the ephemeral credential
store. Refresh requests travel on the private session control channel even outside tool
calls. The Host derives bot/account identity from the bound session, serializes refreshes
per account and coalesces requests for the same previous credential. Workers receive
access tokens and public account metadata, never refresh tokens. API keys use the same
private channel. The credential authority and peer transport run without an Electron window.

Cross-Host sharing uses an explicit account grant bound to the receiving Host's Ed25519
identity, expiry and pinned TLS certificate. Requests are signed, bounded and checked for
nonce replay and time drift. The renderer cannot invoke peer administration directly.
Registered SSH identities establish the pairing; account refresh then travels directly
between services. No SSH keys are copied. Deployments must allow the configured HTTPS
peer port (default 44953) between these Hosts. Communication failure marks the shared
account unavailable rather than asking for a separate bot login.

Account logout refuses while local or remote task leases are active. Revocation prevents
new credentials and turns; renewal of task leases stops when authorization is lost.
Archiving a bot preserves its files and leaves the shared account connected for other bots.
Other Hosts trust the granted Host service to enforce its own bot/session authorization.

## Legacy migration

Migration is explicit for each existing account and preserves bot ID, VM, history, memory,
files and model. A restricted guest operation exports only the old auth file. The Host
imports it into a new private authority and verifies it before committing guest cleanup.
The durable migration phases prevent a retry from replacing rotated credentials. The
guest writes a durable digest marker before removing the old auth file; unknown commit
acknowledgement requires reconciliation. Different old logins are not silently merged.
A retained setup without credentials can attach an existing general account without
creating another bot or preparing its environment again.

SQLite schema 4 adds accounts, grants, links, leases, migration operations and environment
operations. Existing schema-3 rows remain unchanged. Back up the database before upgrading;
older binaries reject schema 4, so restoring old code alone is not a rollback.

## Pinned upstream contract

The external-token flow is an experimental app-server API. Both native authority and
Linux worker are pinned to Codex 0.153.4; initialization enables `experimentalApi`.
See the [pinned upstream app-server documentation](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/app-server/README.md).
The application does not implement the provider's token-refresh HTTP protocol itself.
`fetch:account-runtime` records the native archive and binary hashes; the Host builder
verifies version, architecture and input digests and includes the native binary in its manifest.

## Verification and limits

- Host tests cover independent accounts without bots, model validation, concurrent
  refresh, grant expiry/revocation, wrong certificates, unauthorized peers, private
  event projection, interrupted migration and retained setups.
- Prepared-environment tests reject image/runtime inspection calls, exercise two
  concurrent requests for the last slot, stale inventory, unavailable guest and idempotency.
  In the same fixture the old path made two runtime checks and one image check; the
  direct path makes zero. Fixture timings do not establish physical-host latency.
- `verify:account-runtime` runs actual pinned native Codex against a loopback provider
  with synthetic credentials: 401, refresh callback, retry, no persisted worker auth file
  and logout. This verifies the contract, not a real provider account.
- `verify-bot-sessions.mjs --local-vm --accounts` runs two actual Linux Codex workers
  with a simulated authority and provider. It verifies one coalesced refresh, private
  sessions, reconnect, guest reboot and account reattachment without Electron. It also
  checks desktop input, browser profile/file preservation, network isolation, stream
  revocation and stopping one session without stopping the other. The installed-bundle
  variant verifies the archive hash and executes its actual installer.
- Electron fixtures cover direct creation, general account connection and draft return,
  model/effort selection, separate environment management, keyboard navigation and themes.

The measured two-session profile uses a VM with 2 CPUs, 2048 MiB RAM and a 12 GiB disk;
each worker has 768 MiB, 100% CPU and 256 tasks. This is a limited synthetic workload,
not a guarantee for arbitrary authenticated model tasks. Disk admission budgets are
reservations, not hard per-user filesystem quotas. Real account migration, token renewal
against the real provider and physical laboratory acceptance remain separate opt-in checks.
