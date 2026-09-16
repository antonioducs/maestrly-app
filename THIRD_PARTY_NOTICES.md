# Third-Party Notices

Maestrly App source is licensed under the repository's [MIT License](LICENSE).
Packaged applications include that license and this notice. Dependencies,
downloadable runtimes, models, and provider services retain their own licenses
and terms.

## Kenney Interface Sounds

The Maestrly alert palette includes eight unmodified WAV files from
[Kenney — Interface Sounds 1.0](https://kenney.nl/assets/interface-sounds),
released under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).

The packaged
[`apps/desktop/resources/sounds/README.md`](apps/desktop/resources/sounds/README.md) records the approved
voice mapping, pinned source commit, archive and file hashes, and confirms that
Maestrly applies no normalization or other transformation. The source license is
distributed beside it as
[`apps/desktop/resources/sounds/LICENSE.txt`](apps/desktop/resources/sounds/LICENSE.txt).

## OpenAI Codex-derived source

Portions of the OpenAI-specific chat harness are adapted from
[OpenAI Codex](https://github.com/openai/codex), including the pinned model
instructions in `apps/desktop/src/main/chat/openai/prompt.ts` and the V4A apply-patch parser
used by the native patch tool.

Copyright 2025 OpenAI

Licensed under the Apache License, Version 2.0.

The complete license from the pinned Codex source, upstream attribution, source
paths, and Maestrly-specific modifications are distributed in
[`apps/desktop/resources/licenses/openai-codex-apache-2.0.txt`](apps/desktop/resources/licenses/openai-codex-apache-2.0.txt).
The remainder of Maestrly is not relicensed by this notice.

## OpenAI Codex runtime

The optional Codex subscription integration downloads the pinned, unmodified
`@openai/codex` 0.153.4 target runtime directly from npm when the user enables
it. The lean application package does not contain that runtime. Its Apache 2.0
license and attribution are recorded in
[`apps/desktop/resources/licenses/openai-codex-runtime-NOTICE.txt`](apps/desktop/resources/licenses/openai-codex-runtime-NOTICE.txt)
and
[`apps/desktop/resources/licenses/openai-codex-runtime-apache-2.0.txt`](apps/desktop/resources/licenses/openai-codex-runtime-apache-2.0.txt).

## OpenAI tunnel-client

The optional ChatGPT Web integration downloads OpenAI's unmodified
[`tunnel-client`](https://github.com/openai/tunnel-client) 0.0.10 directly from
OpenAI when the user enables it. The lean application package does not contain
the executable. The upstream project is licensed under Apache 2.0.

## GitHub Copilot

Maestrly integrates `@github/copilot-sdk` 1.0.7 and supports the optional
`@github/copilot` 1.0.71 target runtime. The target runtime is downloaded
directly from npm when the user enables it and is not included in the lean
application package. The SDK license, CLI license, redistribution conditions,
and attribution are distributed in:

- [`apps/desktop/resources/licenses/github-copilot-sdk-MIT.txt`](apps/desktop/resources/licenses/github-copilot-sdk-MIT.txt)
- [`apps/desktop/resources/licenses/github-copilot-cli-license.txt`](apps/desktop/resources/licenses/github-copilot-cli-license.txt)
- [`apps/desktop/resources/licenses/github-copilot-runtime-NOTICE.txt`](apps/desktop/resources/licenses/github-copilot-runtime-NOTICE.txt)

Use of GitHub Copilot services remains subject to the applicable GitHub terms.
Maestrly is not affiliated with or endorsed by GitHub.

## Anthropic Claude Agent SDK

Maestrly integrates `@anthropic-ai/claude-agent-sdk` 0.3.263 to communicate
with a separately installed and authenticated Claude Code runtime. The package
declares `SEE LICENSE IN README.md`; its distributed README links Anthropic's
[Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms),
[Privacy Policy](https://www.anthropic.com/legal/privacy), and
[data usage policies](https://code.claude.com/docs/en/data-usage).

Maestrly does not redistribute the optional platform-specific Claude Code
binaries shipped as SDK convenience dependencies. Users install Claude Code
separately and authenticate their own Claude subscription.

## Local ML runtime

Native packages include a target-specific Local ML archive containing
Transformers.js, ONNX Runtime, Sharp, and their production dependency closure.
The archive preserves the license files shipped by those upstream packages.
Models are obtained separately and remain subject to their own model-card
licenses and terms. See
[`apps/desktop/runtime-assets/local-ml/README.md`](apps/desktop/runtime-assets/local-ml/README.md).

## Maestrly Host and Bot Desktop laboratory

The Bot uses the repository's Electron, React, TypeScript and Zod dependencies.
The Host uses Node.js (MIT and bundled dependency notices), SQLite (public domain),
and QEMU (GPL-2.0 with component-specific licenses). Firmware such as EDK II has
its own BSD/Apache and bundled component notices. Ubuntu 24.04 images contain
individually licensed packages including cloud-init (Apache-2.0/GPL-3.0) and QEMU
Guest Agent (GPL-2.0). libguestfs build tools are GPL/LGPL; they are not Host runtime dependencies.

No QEMU/firmware/Linux binary is committed or claimed qualified here. The runtime
builder requires explicit source URLs, versions, SHA256 digests and license data
for every supplied file and records a package manifest after signing. Distributors
must include each component's actual license notices and fulfill corresponding
source obligations for the versions they distribute. Image builds record the dated
Ubuntu source, input digest, complete installed package inventory and output digest.
No public distribution is performed by the laboratory packaging commands.

Primary references: [QEMU licenses](https://www.qemu.org/docs/master/about/license.html),
[Node licenses](https://github.com/nodejs/node/blob/main/LICENSE),
[Ubuntu cloud images](https://cloud-images.ubuntu.com/releases/noble/),
[NoCloud provisioning](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html),
[libguestfs customization](https://libguestfs.org/virt-customize.1.html).

## Maestrly Bot Linux runtime bundle

The optional Linux Arm64 bundle built by `scripts/build-bot-runtime.mjs` packages only
inputs whose paths, SHA-256 digests, licenses and sources are declared in the private
`MAESTRLY_BOT_BUILD_CONFIG` manifest: Node.js (MIT), the OpenAI Codex CLI app-server
(Apache-2.0), a Chromium build (BSD-3-Clause and the licenses bundled in its
`LICENSES` file) and [`playwright-core`](https://github.com/microsoft/playwright)
(Apache-2.0), whose license file is copied beside the bundled module. The bundle
manifest records every declared input; nothing is downloaded at build or install
time. Xvfb, Openbox and other packages present in the prepared guest image keep the
licenses recorded in that image's package inventory.

### Per-bot Linux desktop input and capture

The session bundle adds Ubuntu ARM64 packages `xdotool` and `libxdo3`
(1:3.20160805.1-5build1, BSD-3-Clause) and `scrot` (1.10-1build2,
MIT-feh/BSD-3-Clause). `xauth` (1:1.1.2-1build1) comes from the pinned Ubuntu
X11 closure. Exact `.deb` hashes accompany the offline addon. The packages retain
their original copyright files under `/usr/share/doc` in the guest; no desktop
input or capture binary is executed on the controller Mac.

### Live desktop (phase 3)

The read-only live screen adds Ubuntu ARM64 packages `tigervnc-scraping-server` and
`tigervnc-common` (1.13.1+dfsg-2build2, GPL-2.0-or-later with the component notices in
their Debian copyright files) and `libfile-readbackwards-perl` (1.06-2, Artistic or
GPL-1.0-or-later). Only `/usr/bin/X0tigervnc` runs, inside the guest, listening on a
private Unix socket with keyboard, pointer, clipboard and resize refused. Exact `.deb`
hashes accompany the offline addon; distributors must honor the corresponding source
obligations for these exact Ubuntu versions.

The Maestrly Bot app bundles [noVNC](https://github.com/novnc/noVNC) 1.7.0
(`@novnc/novnc`; core library MPL-2.0, incorporated files listed in its `LICENSE.txt`)
as a view-only decoder in the renderer. The app ships none of noVNC's HTML, CSS, fonts
or images; the unmodified MPL-2.0 sources are those of the pinned npm package.
