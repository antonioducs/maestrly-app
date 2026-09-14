# Ubuntu 24.04 ARM64 bot desktop image

`node scripts/build-bot-image.mjs /absolute/private/bot-image-config.json` creates
`dist/ubuntu-24.04-<releaseDate>-bot-desktop-arm64.qcow2` and its SHA256 manifest.
It refuses to replace an existing image. The phase1 builder and image remain independent.
The only VM affected is the uniquely created disposable builder; no Host/controller
settings or managed VM lifecycle commands are used. Build networking uses QEMU user
networking with no forwarded ports. Native Apple Silicon macOS with HVF is required.

Use the existing private phase1 image-build configuration as the starting point:
`architecture`, `releaseDate`, dated official Ubuntu Noble `sourceUrl`,
`inputDirectory`, `base: {path, sha256}`, `runtimeBuildConfig`, and
`guestAgentVersion`. Add a `packages` object mapping **every** entry exported as
`requiredBotPackages` in `scripts/build-bot-image-qemu.mjs` to an exact Ubuntu
ARM64 package version. Include the same `qemu-guest-agent` version as
`guestAgentVersion`. Resolve versions from the official Noble main/universe and
updates/security package indexes; unavailable pins deliberately fail the build.
Keep machine-specific paths and private build configuration outside tracked files.
Every QEMU runtime input and the base image are digest-verified before use.

The image installs Xvfb, Openbox, pcmanfm, xterm, a session D-Bus, fonts and shared
libraries required by Chromium using `apt-get --no-install-recommends`. It does
not install GNOME, Ubuntu Desktop, a login manager, snap Chromium or a browser.
Direct dependencies have exact versions; transitive versions are captured in the
full `dpkg-query` inventory. This is not a byte-reproducible apt snapshot build.

The session uses display `:10` at 1280×800, waits for X readiness, starts the file
manager in `/home/maestrlybot/workspace`, and opens a Bash terminal. The Openbox
right-click menu can reopen Files and Terminal; Super-E and Super-Return are
shortcuts. Chromium is launched by the separately installed bot runtime. The
session uses a private D-Bus and disables TCP access to X. The desktop/runtime
systemd units share their private `/tmp` namespace for the X socket.

## Installing the runtime later

This output is a **prepared prerequisite base**, not a fully installed bot.
The runtime bundle builder independently packages `deploy/bot-runtime/linux`
under `install/`. Its installer interface is:

```sh
sh install.sh --bundle /path/to/bot-runtime.tar.gz --sha256 <verified-sha256> --version <bundle-version>
```

Run that installer as guest root through the supported provisioning path on a
writable clone of the prepared base. It creates `/opt/maestrly-bot`, copies the
systemd units and enables them. Provision the runtime control/egress virtio ports
before starting those services. The prerequisite base includes the desktop files
under `/opt/maestrly-desktop` for build verification; the installed runtime uses
its own packaged copies under `/opt/maestrly-bot/install`. Rebuild the bundle after
changing those desktop assets. Do not inject build credentials or enable an SSH
login to publish the image.

## Measurement and qualification

The build starts the desktop as `maestrlybot`, checks X and the Openbox, pcmanfm
and xterm processes, waits 15 seconds, and records `/proc/meminfo` and desktop
process RSS in `desktopMeasurement` in the manifest. Conditions are 2 vCPUs and
2048 MiB assigned RAM, during the preparation boot, without Chromium. RSS values
share pages and must not be summed as unique physical memory. This is not a
measured minimum RAM requirement, an offline cold boot result, or a full bot
qualification. Validate browser launch, offline cold boot, control/egress channels
and idle/load memory on a disposable clone with the final bundle before changing
the minimum offered by the product. The image has a 12 GiB virtual disk ceiling
inherited from the cloud-image workflow; sparse physical size is distinct.

Verification: `node --test tests/bot-image.test.mjs` and
`sh -n deploy/bot-runtime/linux/desktop-session.sh`. A successful real build also
requires guest package inventory matches, desktop smoke checks, QEMU shutdown,
`qemu-img check`, and the resulting output SHA256.

For an offline cold boot measurement without a browser, run:

```sh
node scripts/measure-bot-image.mjs /absolute/private/runtime-build-config.json dist/ubuntu-24.04-20260826-bot-desktop-arm64.qcow2
```

This verifies input hashes, boots a disposable overlay with no NIC, 2 vCPUs and
1024 MiB assigned memory, waits for QGA and checks the desktop after 15 seconds.
It prints JSON with time to QGA and memory observations and deletes only its own
overlay. The timing includes overlay and VM preparation overhead,
so it is an upper bound for VM boot-to-QGA rather than isolated guest boot time.

## Local observation, 2026-09-13

Prepared artifact: `dist/ubuntu-24.04-20260826-bot-desktop-arm64.qcow2`,
3,098,804,224 file bytes, SHA256
`d430c0234210dd453a9bf6849f2109bc2c1652f2f7a0baff4feecdbaf2f5162a`.
The real build passed desktop checks, exact package inventory checks and
`qemu-img check`. The manifest records all installed packages. Its inventory
contains none of `ubuntu-desktop`, `gnome-shell`, `gdm3` or `gnome-session`.

The independent offline measurement exited successfully using the command above.
Time to QGA was 8,651 ms including overlay preparation. With 1024 MiB assigned,
the guest reported MemTotal 974,612 KiB and MemAvailable 723,732 KiB after the
15-second desktop settling interval: approximately 245 MiB by
`MemTotal - MemAvailable`. Xvfb RSS was 18,256 KiB, Openbox 18,328 KiB,
pcmanfm 84,180 KiB and xterm 7,392 KiB. These are local observations without
Chromium, not a minimum specification. Private reproducibility inputs and raw
measurement are in `.host-lab/bot-image-build/config.json` and
`.host-lab/bot-image-build/offline-measurement.json`.

The complete bundle was subsequently installed and tested offline on a disposable
clone: see [final package verification](bot-runtime/offline-environment-verification.md).
