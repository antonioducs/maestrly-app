# Maestrly Host — Phase 1

Maestrly Host is a standalone macOS service for persistent Linux VMs. The installed process runs as `_maestrlyhost` in the launchd **system** domain, independently of a desktop login. Installation needs an administrator; VM execution never runs as root.

This slice is **unqualified until real packaged artifacts and physical Mac hardware pass the lab checks**. Unit tests with supplied facts do not establish hardware support. No target discovery or remote action is automatic.

## Installation layout and trust

The fixed executable is `/Library/MaestrlyHost/bin/maestrly-host`. Its bundled Node 22 runtime, JavaScript, native HVF probe, configuration and image/runtime catalogues are administrator-owned and not group/world writable. The dedicated account owns only:

- `state/` (0700): SQLite metadata, VM overlays, private QMP and guest-agent sockets.
- `log/` (0700): metadata-only daemon logs; 1 MiB active log plus three rotated generations.
- `run/` (0750): `host.sock` (0660), accessible to the `_maestrlyhost` operator group.

Operator group membership grants the complete host lifecycle API for this installation. It is an administrative trust boundary, not tenant isolation. An administrator adds approved SSH users explicitly using `dseditgroup -o edit -a USER -t user _maestrlyhost`; users must reconnect. The installer does not edit sudoers. It requires an explicit operator name or `--no-operator`; selecting a local operator grants membership during installation.

The service accepts version 1 newline-delimited JSON only. `rpc-stdio` bridges validated requests to the fixed private socket and reserves stdout for wire responses. It accepts no socket path, runtime path, SSH target, shell command or guest-command arguments. Each frame is limited to 1 MiB, each connection to 16 pending requests, and the service to 32 connections. Idle connections expire after 30 seconds. Responses are correlated by request ID. Provider errors are sanitized; logs contain event names and timestamps only.

```json
{"version":1,"id":"inspect-1","method":"host.inspect","params":{}}
```

The shared host protocol owns `host.inspect`, `vm.list/create/inspect/start/shutdown/restart/remove/verify`, `operation.get/cancel`, `events.list` and `image.list`. Mutations return durable operations. Poll operation status, use unique idempotency keys and read the current VM revision before lifecycle mutations. A timeout is not proof that a mutation did not happen. Arbitrary QMP, paths, host commands and guest execution are absent from the API. `vm.verify` accepts only `vmId` and `mode: write-marker|read-marker`; its fixed marker is the immutable VM identity. Removal retains data unless `deleteData: true` is explicitly requested.

## Doctor evidence

`maestrly-host doctor` emits JSON with `supported`, `blocked` or `needs_action`, individual checks and the observed facts. Exit 0 means measured prerequisites passed; exit 2 means blocked or missing evidence. It checks macOS, physical architecture, Rosetta translation, the physical Mac model, macOS version, IOPlatformUUID, physical CPU count, RAM, available storage on `/Library`, an actual Hypervisor.framework VM create/destroy probe and QEMU runtime smoke evidence from service `host.inspect`. Helper capability and runtime smoke are listed separately. FileVault and sleep facts are sanitized, read-only operational conditions; no settings are changed.

Phase 1 requires native Apple Silicon or Intel execution, a recognized physical Mac model, macOS 13+, 4 GiB RAM and 20 GiB available storage. Unknown evidence remains unverified. Virtual Macs, translation and failed HVF execution are blocked. These minimums are admission policy, not claims that every matching Mac has been qualified. `supported` from doctor establishes prerequisites only; it does not establish image compatibility or lifecycle correctness. Runtime availability alone is insufficient: the service must advertise `runtime.hvf-smoke` after actual QEMU smoke.

The probe must be a native signed executable at `bin/hvf-smoke`, built from `deploy/host/macos/hvf-smoke.c` with the supplied hypervisor entitlement. It creates and destroys a VM without executing guest code. The installer runs it as the dedicated service account before launchd bootstrap. Doctor also runs it under the calling identity, so an operator-side result cannot replace the service-account installation check.

Before installation, the audited remote doctor gathers only identity and available platform facts using fixed system commands and reports `needs_action`; it cannot qualify an absent package. It never provisions, installs or changes configuration.

## Package and fresh installation

See [artifact build requirements](host-artifact-build.md). The installer requires a reviewed, root-owned, non-writable package staged at `/private/var/tmp/maestrly-host-package`. Staging and administrator review are explicit prerequisites. The lab `transfer` and `deploy` commands stream only an explicitly configured package after full manifest verification; they leave administrator review and root ownership establishment separate.

Required files include `bin/maestrly-host`, `bin/hvf-smoke`, `runtime/bin/node`, `app/cli.mjs`, `etc/host.json` and `install/com.maestrly.host.plist` and `manifest.json`. Every regular file must appear in the SHA256 manifest, except the manifest itself, whose digest is supplied explicitly. The bundled Node verifies this complete inventory after root ownership is established and before installation effects. The package must contain regular files and directories only, without symlinks, hardlinks or special files. `etc/host.json` supplies explicit `runtimes` and `images` matching `HostServiceOptions`, including absolute installed asset paths and SHA-256 checksums. The installer fixes `stateDirectory` and applies the explicitly authorized CPU, memory and disk caps.

The installer accepts `--authorize-install NAMESPACE EXPECTED_IOPLATFORMUUID CPUS MEMORY_MIB DISK_GIB MANIFEST_SHA256 OPERATOR_OR_--no-operator`. It refuses existing installation paths, launchd jobs, accounts and groups rather than replacing them. It refuses caps above measured physical CPU/RAM/free disk on `/Library`, validates the explicit operator choice, creates a dedicated unused local system identity and bootstraps `com.maestrly.host`. A failure leaves evidence for manual review and never recursively deletes existing state. Upgrades, uninstall and migration require a separately reviewed procedure.

## Operation and recovery

Use `maestrly-host status` for service status, `maestrly-host diagnostics` for sanitized doctor/service evidence, and `launchctl print system/com.maestrly.host` for launchd status and the structured doctor/API for host state. Daemon event logs are in `log/host.jsonl`; they are private to the service account. launchd stdout/stderr go to `/dev/null` so subprocess diagnostics do not create unbounded logs or disclose paths through the bridge.

On a normal SIGTERM the daemon stops accepting clients and drains accepted core operations. Guest processes remain independently managed by the core provider. Stale or uncertain process state requires reconciliation through the core's private identity checks. An existing public socket is never blindly replaced. After the HostService ready lock is acquired, daemon startup recovers a socket only when the socket and its private parent are owned by the service identity, a connection probe returns ECONNREFUSED, and inode/device/ownership remain unchanged. Live sockets, symlinks, regular files and uncertain ownership are retained for operator review.

Guest persistence markers, service restart under active guests, recovery after forced daemon termination, logout survival, actual resource limits and signed runtime compatibility must be validated on real hardware before release. See [the explicit lab workflow](maestrly-host-lab.md). The lab checks two guests with the constrained `vm.verify` marker API across SSH reconnect, guest reboot and cold start. Successful evidence can pass; failures preserve guests and reports, and removal preserves data unless explicitly authorized otherwise. Physical host reboot, logout and forced-daemon recovery still need real hardware qualification.

## Current candidate artifact

The measured Arm64 candidate uses Node 22.23.2, QEMU 11.1.1 and a prepared Ubuntu
24.04 image dated 2026-08-26 with QEMU Guest Agent `1:8.2.2+ds-0ubuntu1.18`.
Its Mach-O deployment minimum is **macOS 26.0**, which is stricter than the generic
doctor admission baseline of macOS 13. The installer checks the artifact's actual
minimum and physical architecture before changing the system. No Intel package
has been qualified. See the [candidate catalogue](../deploy/host/macos/runtime-arm64.candidate.json)
for source digests, critical files and evidence scope.

Guests provide a bounded 64 KiB serial console ring, readable through `vm.logs`
after active operations finish. It is not a terminal and accepts no input commands.
The Bot strips control sequences and displays a limited text view. Image preparation
masks the guest's network-online wait service because production VMs have no NIC.
This changes only the guest image; it does not change Host power or networking settings.
