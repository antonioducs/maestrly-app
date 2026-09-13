# Explicit host lab workflow

No alias discovery or remote action occurs without a private `.maestrly-host-lab.json` in the current directory. It must be owned by the current user with mode 0600. This file and `.host-lab/` are gitignored. Use placeholders only in committed documentation.

```json
{
  "sshAlias": "your-explicit-lab-alias",
  "expectedIdentity": "12345678-1234-1234-1234-123456789ABC",
  "namespace": "lab-example",
  "caps": { "cpus": 4, "memoryMiB": 4096, "diskGiB": 40 },
  "packageDirectory": "/absolute/path/to/reviewed-package",
  "manifestPath": "/absolute/path/to/reviewed-package/manifest.json",
  "manifestSha256": "replace-with-64-lowercase-hex-digest",
  "operator": "approvedlocaluser",
  "authorizeInstall": false,
  "authorizeSmoke": false,
  "authorizeDeleteData": false,
  "runtimeId": "your-reviewed-runtime-id",
  "imageId": "your-reviewed-image-id"
}
```

Replace the UUID with measured IOPlatformUUID and the digest with the builder's manifest SHA256. Package fields are needed for transfer; omit them for doctor-only use. Installation requires an explicit existing local operator name, or `operator: null` to intentionally leave operator access disabled. The installer does not infer membership from SSH or sudo environment variables.

SSH explicitly sets `StrictHostKeyChecking=yes`, `ForwardAgent=no`, `ClearAllForwardings=yes`, `ForwardX11=no` and batch mode. Control socket reuse is disabled, so each RPC closes its SSH session before the next one starts. The operator must already trust the target host key. There are no passwords, host-key bypasses, arbitrary remote commands, or physical reboot actions.

## Read-only doctor

```sh
node scripts/host-lab.mjs doctor
```

The fixed audited shell probe measures identity, physical CPU count, RAM and free space on `/Library`, plus sanitized FileVault and power-management facts. It changes no settings. Before installation, missing executable probes and service evidence produce `needs_action`. After installation, doctor invokes the signed helper and calls the service's actual `host.inspect` to distinguish helper HVF capability from QEMU runtime smoke. A runtime must publish `runtime.hvf-smoke` capability based on a real smoke, in addition to availability, before doctor accepts runtime evidence. Raw command output and runtime error paths are excluded from reports.

Reports are written to private per-run directories under `.host-lab/`. Identity is compared before transfer, installation or lifecycle mutation.

## Transfer and deploy

```sh
node scripts/host-lab.mjs transfer
npm run lab:host:deploy
```

Both transfer the explicitly configured package. The deploy command now exists and runs the transfer phase; it reports `needs_action` (exit 2) for the separate administrative installation step. Transfer verifies the pinned manifest and every file, rejects missing, extra, linked or special files, then repeats verification on a private local snapshot before streaming its generated archive over SSH.

The fixed remote staging path is `/private/var/tmp/maestrly-host-package`. Exclusive directory creation refuses any previous staging, including partial failed transfers. No previous installation is overwritten. Transfer does not use sudo or change ownership. An administrator must review the staged contents, compare the pinned digest, and establish root ownership with no group/world write permissions before installation. Failed staging is retained for review.

## Installation opt-in

After administrator review and ownership establishment, set `authorizeInstall: true` and run:

```sh
node scripts/host-lab.mjs install --authorize-install
```

Both config authorization and the CLI flag are required before contact for this command. The fixed installer uses existing `sudo -n` authorization and does not alter sudoers. It checks hardware identity and physical CPU/RAM/free-disk caps, requires a full manifest pinned by SHA256, and verifies all package file hashes using the bundled Node after root ownership checks. It validates the explicit operator choice before creating installation resources. Selected operator membership is applied during installation; reconnect afterward. Existing installation resources are refused, and failures preserve evidence. See [host operations](maestrly-host.md).

## Two-guest persistence smoke

Set `authorizeSmoke: true`, supply exact image/runtime catalogue IDs, then run:

```sh
node scripts/host-lab.mjs smoke --authorize-smoke
```

Doctor must pass. Smoke checks allocations against both service capacity and explicit lab caps. Two guests must fit the image's reported minima (protocol baseline: one CPU, 256 MiB RAM and the image's virtual disk size). When capacity permits, each guest receives up to two CPUs and 2048 MiB for practical boot headroom. Insufficient capacity reports concurrency `blocked` before mutations. An occupied namespace is refused.

Smoke creates two guests, records their IDs and immutable identities, starts both and uses `vm.verify` to write the fixed guest marker equal to each VM's identity. It requires readiness, marker equality, network isolation and boot IDs. Fresh SSH sessions must observe both identities still running and the markers unchanged. Each guest is restarted and cold-started, with persistent markers and changed boot IDs required after each boot. No physical host reboot occurs.

Each lifecycle intent, revision and idempotency key is fsynced before sending the request. Accepted operation IDs are fsynced immediately after the reply and before polling or subsequent effects. The host may start an accepted operation before its acknowledgement arrives; a lost acknowledgement is recovered using the pre-recorded idempotency key, not a new create. Completed operations and verification evidence are also recorded. Only IDs created by this run are eligible for removal, and name/identity are rechecked before each mutation.

Removal sends `deleteData: false` by default, retaining VM data. Only `authorizeDeleteData: true` permits `deleteData: true`. Any failure leaves guests and journals for inspection; there is no speculative cleanup. A fully evidenced run returns `supported` and exit 0. Mock tests do not qualify physical hardware.

Use an otherwise idle dedicated lab host and avoid concurrent mutation. Namespace labels are ownership bookkeeping, not an authorization boundary. Reconcile uncertain operations using their saved idempotency keys and IDs before retrying.

The optional Vitest hardware wrapper is `npm run test:lab:host`. It is skipped
unless `MAESTRLY_HOST_LAB_TEST=1`; the private config must still authorize smoke
and identify the exact Host. Neither ordinary PR checks nor fixture E2E tests
set this flag. Native controller tests are documented separately in
[artifact builds](host-artifact-build.md) and do not qualify the Mac mini.
