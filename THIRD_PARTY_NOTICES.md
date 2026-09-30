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

## noVNC

The desktop app includes the npm package [`@novnc/novnc`](https://www.npmjs.com/package/@novnc/novnc)
1.7.0 from [noVNC](https://github.com/novnc/noVNC) for remote bot screen viewing
and control. Its core is licensed under MPL-2.0.
The upstream notice, authors, and license are distributed in
[`novnc-NOTICE.txt`](apps/desktop/resources/licenses/novnc-NOTICE.txt),
[`novnc-AUTHORS.txt`](apps/desktop/resources/licenses/novnc-AUTHORS.txt), and
[`novnc-MPL-2.0.txt`](apps/desktop/resources/licenses/novnc-MPL-2.0.txt).
The bundled pako code's MIT license is in
[`novnc-pako-MIT.txt`](apps/desktop/resources/licenses/novnc-pako-MIT.txt).
The other upstream texts are
[`novnc-BSD-2-Clause.txt`](apps/desktop/resources/licenses/novnc-BSD-2-Clause.txt),
[`novnc-BSD-3-Clause.txt`](apps/desktop/resources/licenses/novnc-BSD-3-Clause.txt),
and [`novnc-OFL-1.1.txt`](apps/desktop/resources/licenses/novnc-OFL-1.1.txt).

## ws

The bot gateway includes [ws](https://github.com/websockets/ws) 8.22.0 for
WebSocket communication. It is licensed under the MIT License.

Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

The complete license and attribution are distributed with the `ws` package in
`node_modules/ws/LICENSE` inside the gateway image.

## ssh2

The desktop app includes [ssh2](https://github.com/mscdex/ssh2) 1.17.0 to install
and reach a bot server on a VPS over SSH. It is licensed under the MIT License,
Copyright Brian White. Its dependencies are:

- [asn1](https://github.com/joyent/node-asn1) 0.2.6, MIT License, Copyright (c)
  2011 Mark Cavage;
- [bcrypt-pbkdf](https://github.com/joyent/node-bcrypt-pbkdf) 1.0.2, BSD-3-Clause
  License, Copyright 1997 Niels Provos, Copyright (c) 2013 Ted Unangst, and
  Copyright 2016 Joyent Inc;
- [tweetnacl](https://github.com/dchest/tweetnacl-js) 0.14.5, dedicated to the
  public domain under the Unlicense;
- [safer-buffer](https://github.com/ChALkeR/safer-buffer) 2.1.2, MIT License,
  Copyright (c) 2018 Nikita Skovoroda.

Where they build, it also uses the optional native modules
[cpu-features](https://github.com/mscdex/cpu-features) 0.0.10 and
[buildcheck](https://github.com/mscdex/buildcheck) 0.0.7 (MIT License, Copyright
Brian White) and [nan](https://github.com/nodejs/nan) 2.29.0 (MIT License,
Copyright (c) 2018 NAN contributors). The complete licenses are distributed with
each package under `node_modules` in the packaged app.

## OpenAI Codex-derived source

Portions of the OpenAI-specific chat harness are adapted from
[OpenAI Codex](https://github.com/openai/codex), including the pinned model
instructions in `apps/desktop/src/main/chat/harness/profiles/gpt-5.6-sol/prompt.md` (provenance,
hashes and adaptations in the adjacent `config.json`) and the V4A apply-patch parser
used by the native patch tool.

Copyright 2025 OpenAI

Licensed under the Apache License, Version 2.0.

The complete license from the pinned Codex source, upstream attribution, source
paths, and Maestrly-specific modifications are distributed in
[`apps/desktop/resources/licenses/openai-codex-apache-2.0.txt`](apps/desktop/resources/licenses/openai-codex-apache-2.0.txt).
The remainder of Maestrly is not relicensed by this notice.

## OpenAI Codex runtime

The optional Codex subscription integration downloads the pinned, unmodified
`@openai/codex` 0.155.1 target runtime directly from npm when the user enables
it. That version is the reference and minimum for this build; the user can also
install later unmodified stable releases of the same official package from the
app settings. The lean application package does not contain any of these
runtimes. Their Apache 2.0 license and attribution are recorded in
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

Maestrly integrates `@anthropic-ai/claude-agent-sdk` 0.3.285 to communicate
with a separately installed and authenticated Claude Code runtime. The package
declares `SEE LICENSE IN README.md`; its distributed README links Anthropic's
[Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms),
[Privacy Policy](https://www.anthropic.com/legal/privacy), and
[data usage policies](https://code.claude.com/docs/en/data-usage).

Maestrly does not redistribute the optional platform-specific Claude Code
binaries shipped as SDK convenience dependencies. Users install Claude Code
separately and authenticate their own Claude subscription. Fleet bots can also
download newer official `@anthropic-ai/claude-code-linux-<arch>` packages from
the npm registry into their own environment, under the same terms.

## Local ML runtime

Native packages include a target-specific Local ML archive containing
Transformers.js, ONNX Runtime, Sharp, and their production dependency closure.
The archive preserves the license files shipped by those upstream packages.
Models are obtained separately and remain subject to their own model-card
licenses and terms. See
[`apps/desktop/runtime-assets/local-ml/README.md`](apps/desktop/runtime-assets/local-ml/README.md).

For voice dictation the archive also contains:

- the [whisper.cpp](https://github.com/ggml-org/whisper.cpp) N-API addon from
  [`@fugood/node-whisper-<platform>-<arch>`](https://www.npmjs.com/package/@fugood/whisper.node)
  1.1.3, MIT License, Copyright (c) 2025 ggml / whisper.cpp contributors, Jhen-Jie
  Hong, and Hans Chen. It statically links whisper.cpp and ggml, MIT License,
  Copyright (c) 2023-2026 The ggml authors. The platform packages ship no license
  file, so the texts are distributed as
  [`whisper-node-MIT.txt`](apps/desktop/resources/licenses/whisper-node-MIT.txt) and
  [`whisper-cpp-MIT.txt`](apps/desktop/resources/licenses/whisper-cpp-MIT.txt);
- the [Silero VAD](https://github.com/snakers4/silero-vad) v6.2.0 model in GGML
  format (`ggml-silero-v6.2.0.bin` from
  [ggml-org/whisper-vad](https://huggingface.co/ggml-org/whisper-vad)), MIT
  License, Copyright (c) 2020-present Silero Team, distributed as
  [`silero-vad-MIT.txt`](apps/desktop/resources/licenses/silero-vad-MIT.txt).

The speech model, OpenAI Whisper large-v3-turbo (MIT License, Copyright (c) 2022
OpenAI) in the GGML format published by
[ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp), is not
distributed with Maestrly. It is downloaded from Hugging Face only when the user
chooses to install it for dictation.

## unpdf and PDF.js

Maestrly packages [`unpdf`](https://github.com/unjs/unpdf) 1.8.1 (MIT,
Copyright (c) 2023-PRESENT Johann Schopplich) to extract text from PDF chat
attachments in an isolated utility process. unpdf bundles a serverless build of
[PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist` 6.1.200, Copyright
2012 Mozilla Foundation), licensed under Apache 2.0. The unpdf license ships in
its package directory; the PDF.js attribution and the complete Apache 2.0 text
are in
[`apps/desktop/resources/licenses/pdfjs-apache-2.0.txt`](apps/desktop/resources/licenses/pdfjs-apache-2.0.txt).

## Cursor SDK

Maestrly packages `@cursor/sdk` 1.0.34 and one matching supported native helper
package. These are proprietary Anysphere components, separate from Maestrly's
MIT-licensed source. The upstream license is reproduced verbatim in
[`cursor-sdk-LICENSE.md`](apps/desktop/resources/licenses/cursor-sdk-LICENSE.md);
component attribution is in
[`cursor-sdk-NOTICE.txt`](apps/desktop/resources/licenses/cursor-sdk-NOTICE.txt).
Use of Cursor services remains subject to Cursor's terms. Maestrly is not
affiliated with or endorsed by Anysphere or Cursor.
