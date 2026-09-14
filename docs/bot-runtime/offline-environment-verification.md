# Disposable offline ARM64 verification

Run on native ARM64 macOS after preparing the pinned local host runtime, bot prerequisite image, Linux bot bundle, and `packages/host-core/dist`:

```sh
MAESTRLY_BOT_VERIFY_BUNDLE=/absolute/path/to/versioned-bundle.tar npm run verify:bot-environment
```

`MAESTRLY_BOT_VERIFY_BUNDLE` must select the exact versioned bundle to verify. Its sidecar manifest must match the digest and provide `runtimeVersion`; the verifier never replaces it. The installer is extracted from that verified bundle, not substituted from the worktree. The trusted QEMU input manifest is `.host-lab/runtime-build/host-build-with-image.json`. Every listed input is hash verified before execution, and the bot image is verified against its sidecar manifest. The selected local bundle digest is calculated and checked again by the guest installer.

Each invocation creates `.host-lab/environment-*` containing the read-only seed ISO, unique 12 GiB qcow2 overlay, private UEFI variables, exact QEMU arguments and hashes, serial log, runtime inspect/account response, and (on success) browser result JSON and screenshot PNG. The original image remains the overlay backing file. Keep it in place when examining preserved guest disks. Unique short Unix socket paths are removed after the VM exits. No host credential directories or inherited environment are copied to the guest. The VM has 2 CPUs, 2048 MiB RAM and `-nic none`; it has no network forwarder. SIGINT/SIGTERM terminate the disposable QEMU process.

Cloud-init installs the bundle from a read-only CIDATA volume. It disables only the disposable guest's serial login service to avoid interference with evidence output, executes the bundled Linux Node and Codex version commands, generates JSON schema using that Codex binary, starts the installed desktop/runtime services, and runs a non-root Playwright probe in the desktop's private mount namespace. The actual Host `SocketGuestSession` performs virtio control handshake, `runtime.inspect`, and `auth.status`; no login or paid turn is attempted.

Ubuntu's default AppArmor user namespace restriction rejected the downloaded Chromium path. The guest probe therefore installs this exact-path exception, following [Chromium's documented path-specific approach](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md):

```text
abi <abi/4.0>,
include <tunables/global>
profile maestrly-chromium /opt/maestrly-bot/chromium/chrome flags=(unconfined) {
  userns,
}
```

This permits user namespaces for that root-owned executable; it is not an additional browser confinement policy. The final package installs the corresponding `maestrly-chromium` profile; the verifier requires it and no longer supplies a probe-only workaround. No sysctl changes or sandbox-disabling flags are used. `JoinsNamespaceOf` belongs to the runtime unit’s `[Unit]` section; the browser probe runs in that runtime’s mount namespace to verify access to the shared display.

The browser opens a local HTML file headfully, clicks its button, checks the resulting text, records PNG bytes and SHA256, and positively checks `chrome://sandbox` for namespace, PID/network namespaces and Seccomp-BPF status. `/proc/meminfo` and process RSS are captured before and during the browser. These are observations for this specific short offline workload, not universal minimum RAM, authenticated-model capacity, cold-boot qualification, or production readiness.

The initial real runtime crashed on offline proxy CONNECT resets. `LocalProxy` now attaches a socket error handler at connection acceptance, before policy checks can refuse a request. The focused network regression checks that a reset after offline refusal leaves the proxy available. Original and failed-run artifacts remain preserved under `.host-lab`.

Focused checks:

```sh
node --test scripts/test/verify-bot-environment.test.mjs
npm test --workspace @maestrly/bot-runtime -- --run test/network.test.ts
npm run typecheck --workspace @maestrly/bot-runtime
```

## Observed local run: 2026-09-13

Successful evidence: `.host-lab/environment-XG9Oh3`. Bundle: `.host-lab/environment-fixed-bundle/maestrly-bot-runtime-0.1.0-20260913-arm64.tar`, SHA256 `e30e6e8b97225f4cd778e8b6b0488ea83c924ce14b661ab49561388eab1f0dac`. This separate rebuild includes the proxy fix; the original bundle is not qualified by this run.

- Linux Node `v22.15.0`; `codex-cli 0.153.4`; generated schema inventory: 304 files.
- Installed runtime `0.1.0-20260913` answered `ready` through virtio `SocketGuestSession`, with provider `codex` and account `disconnected`. Its real Codex adapter completed app-server initialization without credentials. The first control attempt timed out during startup; a later session succeeded.
- Chromium ran as UID 999; local click succeeded. Sandbox page confirmed namespace layer, PID/network namespaces and Seccomp-BPF (including TSYNC).
- Guest `MemTotal` was 1955.26 MiB. `MemTotal - MemAvailable` measured 509.06 MiB before browser launch and 633.32 MiB with the local page open; available memory was 1446.20 and 1321.94 MiB respectively. Desktop process RSS summed to 125.27 and 131.47 MiB. Browser process RSS summed to 788.01 MiB, **including shared mappings counted repeatedly**; do not interpret this RSS sum as unique physical usage.
- Screenshot: 13,159 bytes; SHA256 `16c871faca3ef79c435d9af2b601f92a93052b5bb4a3c77ec0cd9c67b7393565`. The host independently verified the extracted PNG's size/hash.
- This does not test authenticated model turns, remote websites, long-running workload stability, or the packaged runtime's complete browser tool path. The browser probe directly uses the bundled Playwright/Chromium in the installed desktop namespace.


## Final package verification: 2026-09-13

The final rerun exited 0 with evidence in `.host-lab/environment-RerylR`.
Its bundle is
`dist/bot-runtime/0.1.0-20260913-r3/maestrly-bot-runtime-0.1.0-20260913-r3-arm64.tar`,
SHA256 `ca1caa75298ca1e8010027df4ad90b1ed8275f36f6dd3eff52d9f1ef781d6b39`.
It includes Node **22.23.2**, Codex **0.153.4**, Chromium **151.0.7922.34**
(Playwright **1.62.1**, revision **1234**), the proxy reset fix, the generated-schema
approval decision fix (`decline`), the lightweight desktop assets and the packaged
AppArmor policy. macOS xattrs/resource forks are excluded from the Linux archive.
The previous dated bundles remain preserved and are not the final candidate.

The installer used in this run came from the archive itself. It installed and
loaded its Chromium AppArmor profile, with no probe-only policy or global sysctl
change. The runtime service's `JoinsNamespaceOf` is in `[Unit]`; the browser probe
ran in **the runtime's mount namespace**, proving access to the desktop display.
The real private control channel returned runtime `0.1.0-20260913-r3`, state
`ready`, provider Codex and account `disconnected`.

All four desktop processes (Xvfb, Openbox, pcmanfm and xterm), Node and Codex were
present under the non-root guest user. With 2 vCPUs, 2048 MiB assigned RAM and a
12 GiB virtual disk, `MemTotal - MemAvailable` was approximately **493 MiB** before
Chromium and **616 MiB** while the local page was open. These measurements include
the probe process and exclude reclaimable memory according to Linux's estimate.
They establish this small workload, not a universal or authenticated-task minimum.
The package's 3/4 GiB planning profile remains explicitly marked as unmeasured.

The local click changed the page text. A new 13,159-byte PNG was recovered and
its SHA256 independently matched
`16c871faca3ef79c435d9af2b601f92a93052b5bb4a3c77ec0cd9c67b7393565`.
Chromium reported namespace, PID/network namespaces and Seccomp-BPF sandboxing
active. This is a browser evidence capture, not remote desktop/takeover support.

The Mac mini was queried read-only with the existing private configuration:
identity matched, macOS 26.6.2 ARM64, Host 0.1.0, both VMs stopped with their
2 CPU/2048 MiB/12 GiB reservations intact. No upgrade, guest preparation,
quota change or provider login was performed there. The prepared image contains
the desktop dependencies; the addon bundle alone does not add missing Ubuntu
packages to a phase-one guest. Existing-guest rollout still requires a verified
offline dependency preparation path and explicit VM/maintenance authorization.

## Remote upgrade continuation: 2026-09-13

A fresh read-only SSH probe matched the configured machine identity. Host remained
at `0.1.0`, with capacity `4 CPU / 8192 MiB / 40 GiB`. Both
`lab-mini-linux-1` and `lab-mini-linux-2` remained stopped, each reserving
`2 CPU / 2048 MiB / 12 GiB`. The probe `sudo -n /usr/bin/true` failed:
noninteractive administrator access is unavailable in this SSH session. No remote
installation, backup, restart, guest preparation or credential transfer occurred.
An administrator must perform the reviewed backup/upgrade on the mini through an
interactive privileged session; merely authorizing maintenance does not supply OS
privileges. Do not enable unrestricted passwordless sudo to work around this.

The upgrade decision now rejects absent or malformed activity/reservation evidence
and absent image references. Its CLI collector still supplies incomplete evidence,
so it intentionally cannot authorize deployment until live evidence collection is
implemented. The focused three-test upgrade suite passes, including a regression
that failed before this change. This is a preflight hardening check, not a deployed
Host qualification.

Remaining deployment blockers: live upgrade evidence collection; an offline Ubuntu
dependency addon for the existing phase-one disk; and replacing the guest helper's
unrestricted root `exec` with an approval boundary inaccessible to ordinary guest
shell commands. The existing r3 archive still contains that helper and must not be
deployed as a secure approved-command runtime. Rebuild and repeat real disposable
VM verification after those changes. Provider login remains a separate user action.
