# Independent bot sessions in one VM

The Host catalogue now uses schema 4. A VM can contain multiple bots, each with a
persistent session ID. Existing schema-2 records are preserved; legacy workspace
ownership conflicts block adoption instead of assigning the same data twice.
The public Bot/VM shapes and RPC envelope stay at v1. Session discovery is gated by
`bot.sessions.v1`; older guests continue through the single-session transport.

The Linux supervisor owns the virtio control and egress devices. Workers connect
through private Unix sockets and cannot issue administrative supervisor RPCs.
Each session has a distinct UID/group, HOME, Codex storage, workspace, journal,
browser profile, Xauthority, temporary directories, network namespace and IPC
namespace. Its runtime and Xvfb/Openbox desktop share only that session's
namespaces. Chromium keeps its namespace sandbox. `NoNewPrivileges`, empty Linux
capabilities and cgroup limits apply independently to each worker session.

The `computer_*` tools use X11 input and full-display captures inside Linux.
They no longer alias Playwright viewport input. Observation IDs are invalidated
by managed actions and display generation changes. Browser tools continue using
Playwright. Root-level VM administration remains outside the model's tool surface.
The supervisor itself is privileged; this is not isolation against malicious VM
root or a shared-kernel exploit.

Egress is keyed by VM/session, with eight streams per managed session and sixteen
aggregate streams per VM. Policies and revocation are independent. DNS address
validation, pinning and peer verification remain in the Host broker. A worker has
only its private loopback; it cannot borrow another bot's proxy. Public internet
and blocked-domain settings are retained per bot. A Host lease also reaches the
supervisor, which stops the session cgroup on expiry. Managed cancellation is not
confirmed solely from a worker acknowledgement: the session process group must stop.

Archiving stops that bot's session and preserves its directories and conversation.
Its identity/user are not recycled. A stopped or archived session does not erase
another bot. VM shutdown/restart affects every resident bot; administration shows
the affected bots and confirms shared-VM interruptions. Purge still requires
archived bots and explicit permanent-data deletion confirmation.

## Evidence gathered locally

The implementation was exercised in a disposable Ubuntu 24.04 ARM64 QEMU/HVF VM
with **2 CPUs, 2048 MiB RAM and a 12 GiB virtual disk**, using `-nic none`.
Two non-root graphical sessions ran simultaneously. The tests performed real X11
clicks and typing on different local pages, captured both displays, downloaded
those PNGs through the session transport and independently checked their hashes.
The captures showed the respective `input-a`/`input-b` values and different colors.

Tests also verified distinct UID/network/mount/IPC namespaces, denied cross-session
workspace/Codex/Xauthority/socket access, denied direct networking, independent
proxy policies, live stream revocation, session lease expiry without stopping the
other runtime, transport reconnect and guest reboot with persistent files/browser
storage. Graphical probes ran with `NoNewPrivileges=1`, zero effective capabilities
and within the session resource slice. A repeated-coordinate mouse test exposed a
blocking `xdotool --sync` wait; ordered move/click commands now avoid that wait.

The tested session profile reserves 384 MiB for the OS and limits each of two active
sessions to 768 MiB, 100% of one CPU and 256 tasks. The disk allowance is an
admission budget, **not a hard per-directory quota**. The final bundle references
the measurement report by SHA256 and refuses unmeasured profile increases.
This qualifies the tested desktop workload with Codex app-server running; it does
not establish a universal minimum for arbitrary authenticated model workloads.

The complete offline bundle was installed using its actual installer in a fresh
disposable overlay and subjected to the same two-session tests. Private PNGs,
package inventories and reports remain in `.host-lab/sessions-test-*`; release
artifacts and manifests are under `dist/bot-runtime/0.1.0-20260914-sessions-r1`.
Neither test image nor its test users/data is a distributable base image.

## Commands and deployment boundary

- `npm run check:bot-sessions` checks types and artifact contracts.
- `npm run test:bot-sessions` covers migration, routing, concurrency and supervisor lifecycle.
- `npm run lab:bot:sessions -- --local-vm` runs disposable Linux validation.
- Set `MAESTRLY_BOT_SESSION_BUNDLE` to validate an exact built bundle with its installer.
- `npm run lab:bot:sessions` performs read-only session discovery on the configured lab Host.
- `npm run lab:bot:sessions -- --authorize-bot-smoke` additionally requires private
  configuration consent and two authenticated ready bots on the selected VM. It
  stores intent/receipts and captures; images require independent visual review.

The Mac mini preflight confirmed two retained VMs, one bot, no active turn and
unchanged authorized quotas (4 CPUs, 8192 MiB, 40 GiB). The selected bot's persisted
network mode was blocklist with no blocked domains. **Remote session migration and
two authenticated bots are not yet qualified by this report.** Administrative
application requires the maintenance window and consistent backups. The prepared
migration preserves the current bot's account, files, thread/history, memory and
policy; the second bot connects its own account through the official login flow.

Shared account delegation is documented and qualified separately in [shared accounts](shared-accounts.md). The schema-3 session migration remains intact; schema 4 adds accounts and environments without rewriting existing bots.
