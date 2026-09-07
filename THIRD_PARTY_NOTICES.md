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
[`resources/sounds/README.md`](resources/sounds/README.md) records the approved
voice mapping, pinned source commit, archive and file hashes, and confirms that
Maestrly applies no normalization or other transformation. The source license is
distributed beside it as
[`resources/sounds/LICENSE.txt`](resources/sounds/LICENSE.txt).

## OpenAI Codex-derived source

Portions of the OpenAI-specific chat harness are adapted from
[OpenAI Codex](https://github.com/openai/codex), including the pinned model
instructions in `src/main/chat/openai/prompt.ts` and the V4A apply-patch parser
used by the native patch tool.

Copyright 2025 OpenAI

Licensed under the Apache License, Version 2.0.

The complete license from the pinned Codex source, upstream attribution, source
paths, and Maestrly-specific modifications are distributed in
[`resources/licenses/openai-codex-apache-2.0.txt`](resources/licenses/openai-codex-apache-2.0.txt).
The remainder of Maestrly is not relicensed by this notice.

## OpenAI Codex runtime

The optional Codex subscription integration downloads the pinned, unmodified
`@openai/codex` 0.153.4 target runtime directly from npm when the user enables
it. The lean application package does not contain that runtime. Its Apache 2.0
license and attribution are recorded in
[`resources/licenses/openai-codex-runtime-NOTICE.txt`](resources/licenses/openai-codex-runtime-NOTICE.txt)
and
[`resources/licenses/openai-codex-runtime-apache-2.0.txt`](resources/licenses/openai-codex-runtime-apache-2.0.txt).

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

- [`resources/licenses/github-copilot-sdk-MIT.txt`](resources/licenses/github-copilot-sdk-MIT.txt)
- [`resources/licenses/github-copilot-cli-license.txt`](resources/licenses/github-copilot-cli-license.txt)
- [`resources/licenses/github-copilot-runtime-NOTICE.txt`](resources/licenses/github-copilot-runtime-NOTICE.txt)

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
[`runtime-assets/local-ml/README.md`](runtime-assets/local-ml/README.md).
