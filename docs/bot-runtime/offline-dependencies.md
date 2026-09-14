# Existing phase1 guest dependencies

The offline addon installs Ubuntu packages into an existing guest filesystem. It does not replace, resize, format, or register a managed VM disk. This path is intended for the existing Ubuntu 24.04 ARM64 phase1 inventory. Installation preserves existing configuration files (`--force-confold`) and prohibits package removal and network downloads. APT still needs sufficient free space and a consistent package database; a materially different guest package state can fail closed and requires separate qualification.

Build locally on native ARM64 macOS:

```sh
node scripts/build-bot-offline-dependencies.mjs
```

The builder verifies every QEMU runtime input from `.host-lab/runtime-build/host-build-with-image.json`, the phase1 image, and the prepared bot desktop image. It compares their exact package inventories, then downloads the pinned difference and its dependency closure with APT in a disposable phase1 overlay. Only that build VM has user-mode egress, without port forwarding. Downloaded package versions and architectures must match the prepared desktop inventory. Ubuntu's APT repository signatures and package checksums remain enabled.

Outputs are created in a fresh `dist/offline-dependencies-*` directory: `maestrly-offline-dependencies-arm64.tar`, its SHA256 manifest, and the extracted `addon` directory. The archive contains the offline installer, exact requested versions, per-deb SHA256 checksums, package metadata, and `.deb` files. Package copyright/license notices are included in the Debian packages and installed under `/usr/share/doc`; repository origins are recorded in the build console. The sidecar records source image hashes and the disposable build evidence path. Temporary overlays and the raw transfer disk remain for investigation; they are not deployable guest images.

To include the addon in a newly versioned runtime, copy the archive beneath the private build configuration's `inputDirectory` and add:

```json
{
  "offlineDependencies": {
    "path": "offline-dependencies.tar",
    "sha256": "<verified archive SHA256>"
  }
}
```

Run `scripts/build-bot-runtime.mjs` with that private configuration and a new version/output path. The builder verifies the addon digest and embeds it under `offline-dependencies/`. The runtime installer executes it before publishing the runtime, inside the already verified runtime bundle. Prepared desktop images can continue to use bundles without this addon. Never silently overwrite a previous runtime build or deploy the historical r3 bundle expecting it to contain Ubuntu packages.

For a standalone addon, verify its SHA256 against the trusted sidecar, extract it to a private directory, and run `sh install.sh` as guest root during the authorized maintenance window. This is guest administration, not a host disk operation. The installer checks Ubuntu version/architecture and each deb checksum, points APT at the local deb cache, disables package sources and downloads, prohibits removals, preserves config files, verifies installed versions, and requires a clean `dpkg --audit`. Package operations can partially apply if a maintainer script fails; retain a consistent backup before production maintenance.

Verify the integrated bundle against phase1 rather than the prepared desktop image:

```sh
MAESTRLY_BOT_VERIFY_IMAGE="$PWD/dist/ubuntu-24.04-20260826-arm64.qcow2" \
MAESTRLY_BOT_VERIFY_BUNDLE=/absolute/path/to/new-versioned-runtime.tar \
node scripts/verify-bot-environment.mjs
```

The verifier creates a fresh overlay and supplies `-nic none`. Before installation it creates a `/home` sentinel and records `/home` inode/ownership/mode, root filesystem UUID and machine ID. After installation it checks all of those and confirms the guest has only loopback, then runs the existing non-root desktop, sandboxed Chromium/local-click and runtime control-channel probes. This establishes in-place installation on a disposable phase1 clone, not remote deployment or authenticated provider operation.

Focused checks:

```sh
node --test scripts/test/build-bot-offline-dependencies.test.mjs scripts/test/verify-bot-environment.test.mjs
npm test --workspace @maestrly/bot-runtime -- --run test/install.test.ts
```

## Verified local artifacts: 2026-09-13

Qualified standalone addon:
`dist/offline-dependencies-r2/maestrly-offline-dependencies-arm64.tar`
(81,005,568 bytes), SHA256
`2f4ad4eb04892eb8b1d87f684d38f390c4636953434c0940803bc18baba94187`.
It contains 127 exact-inventory packages; installed size reported by APT was
357 MB. Download evidence is `.host-lab/dependencies-2liCWs`.

Qualified integrated runtime:
`dist/bot-runtime/0.1.0-20260913-dependencies-r2/maestrly-bot-runtime-0.1.0-20260913-dependencies-r2-arm64.tar`,
SHA256 `7f6a02af83b54b9c7f4ca1ada2f94cdd5b3270ddf4fe3963a54230a8ac80ea15`.
Private rebuild config: `.host-lab/dependency-runtime-config-r2.json`.
This is a dependency-path qualification artifact; subsequent runtime/helper
changes require another versioned build and verification.

The complete verifier exited 0 with evidence in `.host-lab/environment-Y01Ock`.
APT installed 127 packages, upgraded zero and removed zero, with no NIC and
no downloads. Exact versions and `dpkg --audit` passed. The `/home` sentinel,
`/home` inode/owner/group/mode, filesystem UUID and machine ID survived the
installation. The source phase1 image still hashes to
`386f969d80b586468e9363c51cef80177d5b8b51fbb0fb94f76d16e1bab337b3`.

The installed runtime reported `ready`, version
`0.1.0-20260913-dependencies-r2`, and Codex account `disconnected` through the
real virtio control session. All four desktop processes ran as the non-root
guest account. The local browser click passed as UID 999; Chromium confirmed
namespace, PID/network namespaces and Seccomp-BPF sandboxing. The recovered
13,159-byte screenshot independently matched SHA256
`16c871faca3ef79c435d9af2b601f92a93052b5bb4a3c77ec0cd9c67b7393565`.

The first installation attempt (`.host-lab/environment-IXSPfF`) stopped before
package installation because APT's no-download local-file path handling
required an explicit local archive-cache directory. The qualified installer
supplies `Dir::Cache::archives`; the failed evidence and earlier artifacts
remain preserved. No remote host, managed VM, global administrator setting,
or provider account was changed.

A fresh invocation of the final builder also exited 0:
`.host-lab/dependencies-kd8sC4`, output
`dist/offline-dependencies-BnUmjm/maestrly-offline-dependencies-arm64.tar`,
SHA256 `8bce29da62bd57e1163de782229dce616c14f913637b9db34a4015ea9b0dc9bc`.
All 127 deb files, installer, exact-version list, metadata and checksums were
independently compared and match the offline-qualified r2 payload byte for byte.
Tar metadata differs; no byte-identical archive reproducibility is claimed.
