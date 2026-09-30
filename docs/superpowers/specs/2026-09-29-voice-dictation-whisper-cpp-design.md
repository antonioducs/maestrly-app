# Voice dictation with local whisper.cpp — design

Date: 2026-09-29 · Status: proposed

## Goal

Make voice input accurate in Brazilian Portuguese and send it to the conversation
without pressing Enter. Speech stays on the machine: a local whisper.cpp model
transcribes it and the text is submitted as a normal user message.

Today dictation records audio, transcribes it in the `asr-worker` utility process
with `Xenova/whisper-base` through Transformers.js on the CPU, and appends the text
to the draft (`ChatView.tsx`, `BotComposer.tsx`). Three problems make it poor in
Portuguese: `whisper-base` is too small, the language is auto-detected on
clips of a few seconds, and the result still needs Enter.

Agent runtimes (Claude Agent SDK, Codex, Copilot) accept text and images, not
audio, so local speech-to-text is the bridge. The message is the transcription.

## Decisions

| Question | Decision |
| --- | --- |
| Engine | whisper.cpp through `@fugood/node-whisper-<platform>-<arch>` 1.1.3 (MIT N-API addon, statically linked, Metal on macOS, CPU elsewhere). |
| Distribution of the engine | Inside the existing `local-ml-runtime` archive, pinned by its npm lockfile, signed and smoke-tested by the existing pipeline. No new native build toolchain. |
| Package selection | Only the CPU/Metal platform package for the target (`darwin-arm64`, `win32-x64`, `linux-x64`). The `@fugood/whisper.node` wrapper, WASM, Vulkan and CUDA variants are not installed or archived. |
| Speech model | `ggml-large-v3-turbo-q5_0.bin` (574,041,195 bytes, SHA-256 `394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`, MIT), pinned to Hugging Face revision `5359861c739e955e79d9a303bcbc70fb988958b1` of `ggerganov/whisper.cpp`. |
| Model delivery | New runtime asset `whisper-model`, downloaded on demand from the dictation button, then managed in Settings like other runtime components. Nothing is downloaded without an explicit click. |
| Fallback while the model is missing | None. Dictation is unavailable until the model is installed; the Transformers.js speech path and `Xenova/whisper-base` are removed. |
| Silence and noise gate | Silero VAD (`ggml-silero-v6.2.0.bin`, 885,098 bytes, SHA-256 `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987`, MIT) runs before Whisper. No speech segments means no transcription and no message. |
| VAD model delivery | Committed under `apps/desktop/runtime-assets/local-ml/models/` and copied into the runtime archive; it is small and dictation cannot run safely without it. |
| Language | Follows the app language by default (the app supports `en` and `pt-BR`, mapped to Whisper `en` and `pt`). The microphone menu offers "App language" or "Detect automatically". |
| Initial prompt | None. A Portuguese technical prompt did not fix short replies and slightly degraded one sentence in the spike. |
| Auto-send | A "Send automatically" switch in the microphone menu, on by default. When it is off, or the composer cannot send, the text goes to the draft as today. |
| First Metal load | A warm-up transcription runs right after the model installs, so shader compilation (about 17 s once) does not delay the first dictation. |
| Engine isolation | The worker talks to whisper.cpp through a small local interface, so the addon can later be replaced by a self-built binary without touching callers. |
| Supported platforms | macOS 15+ on Apple silicon (the addon's `LC_BUILD_VERSION` minimum is 15.0), Windows x64, Linux x64 with glibc 2.34+ (the addon requires `GLIBC_2.34`). These are the local ML runtime targets. |
| Unsupported systems | Main reports support before anything is downloaded; the microphone shows why dictation is unavailable and never offers the model download. |
| Model asset version | `large-v3-turbo-q5` (runtime versions must match `^[A-Za-z0-9.]+(?:-[A-Za-z0-9.]+)*$`). |

## Spike evidence

Measured on the owner's M2 Pro (32 GB) with Metal, `large-v3-turbo-q5_0`,
synthesized pt-BR speech (clean audio, not a real microphone):

| Case | Result |
| --- | --- |
| Model load, first ever | 16.9 s (Metal shader compilation) |
| Model load, later processes | 0.27 s |
| 5–6 s sentences, language `pt` | 1.0–1.5 s each; technical terms exact ("branch", "pull request", "TypeScript", "chatview.tsx") |
| Same, automatic language detection | about 2.0 s each, same text |
| 2 s digital silence without VAD | Whisper output "E aí" |
| 2 s pink noise without VAD | Whisper output "Obrigado." |
| VAD on silence and noise | 0 segments in 10–14 ms |
| VAD on speech | segments in 10–22 ms |
| Single words ("Sim.") | "5." / "Save." with the synthesized voices; "Não.", "Pode seguir." correct |

Short single-word replies with real microphone audio remain the main quality risk
and are part of the acceptance test.

## Out of scope

- Streaming or partial transcription while speaking, and continuous hands-free
  mode (VAD endpointing that stops recording by itself).
- GPU acceleration on Windows and Linux (Vulkan/CUDA variants).
- Model choice in Settings (smaller or larger models).
- Dictation in `apps/web` and on remote bots' own machines. The bot composer on the
  Mac uses the same local dictation.
- Local LLM post-processing of the transcript.
- Sending audio to providers that accept audio input.

## Architecture

```mermaid
flowchart LR
  subgraph Renderer
    MB["ChatMicButton\nrecord → 16 kHz mono PCM"] -->|model missing| DL["download card\nruntimeAssetInstall('whisper-model')\nprogress, cancel"]
    MB -->|chatTranscribe(pcm, language)| IPC
    MB -->|autoSend on + onAutoSend() true| SEND["ChatView.submitDraft /\nBotComposer.send"]
    MB -->|autoSend off or rejected| DRAFT["append to draft"]
  end
  subgraph Main
    IPC["chat:transcribe"] --> SVC["asr-service\nready + lease local-ml-runtime\nready + lease whisper-model"]
    SVC --> W["asr-worker (utilityProcess)\nFloat32 → Int16\nVAD → speech span\nWhisper(language)"]
    W --> RT["local-ml-runtime\nruntime.mjs → loadWhisper()\n@fugood/node-whisper-*\nmodels/ggml-silero-v6.2.0.bin"]
    W --> M["whisper-model asset\nggml-large-v3-turbo-q5_0.bin"]
  end
```

### Local ML runtime

- `runtime-assets/local-ml/package.json` adds the three platform packages as
  `optionalDependencies` pinned to `1.1.3`; npm installs only the one matching
  `npm_config_os`/`npm_config_cpu`, which also keeps the macOS → Windows
  cross-build working.
- `scripts/build-local-ml-runtime.mjs` collects
  `@fugood/node-whisper-<platform>-<arch>` and
  `models/ggml-silero-v6.2.0.bin` (hash-checked before archiving). Its `index.node`
  and the VAD model become critical paths. The existing macOS signing pass signs
  the addon as a Mach-O entry.
- `runtime.mjs` keeps the Transformers.js exports for embeddings and adds
  `loadWhisper()` (a `createRequire` of the platform package) and `vadModelPath`.
- The runtime version becomes `2.17.2-2`; `manifest.json` is rebuilt for all
  targets.
- `scripts/smoke-local-ml-runtime.mjs` loads the addon and creates a
  `WhisperVadContext` from the bundled VAD model, which proves the native load and
  the model path. `verify-cross-local-ml-runtime.mjs` checks the PE header of the
  Windows `index.node`.
- `prepare-local-ml-models.mjs` and the runtime README drop `Xenova/whisper-base`
  and document the new asset for offline machines.

### Model runtime asset

- `RuntimeAssetId` gains `whisper-model`. The same target applies to every host
  that has a local ML runtime target (`mac-arm64`, `linux-x64`, `win-x64`).
- `ArchiveFormat` gains `file`: the verified download is moved into staging under
  a declared `fileName` instead of being extracted. Markers, leases, disk
  preflight, repair and removal behave as for archives.
- `downloadBytes` and `maxDownloadBytes` equal the exact size. The HTTPS downloader
  allows `huggingface.co` and redirects to `*.hf.co` (the CDN host varies by
  region); the pinned SHA-256 remains the integrity check.
- Settings shows it as "Voice model" / "Required by voice dictation", with its disk
  usage and a remove action. The stale-temp cleanup pattern includes the new id.

### Transcription worker and service

- `asr-worker.ts` replaces the Transformers.js pipeline. On `init` it receives the
  runtime module URL, the model path and `useGpu` (true on macOS). It lazily
  creates one `WhisperContext` (`useFlashAttn: true`) and one `WhisperVadContext`,
  reused across requests and released on exit.
- A request converts Float32 PCM to signed 16-bit PCM, keeps the existing RMS
  diagnostics, runs VAD, and returns `silent` when there are no segments.
  Otherwise it transcribes the span from the first segment start to the last
  segment end, padded by 300 ms, with the requested language (`auto` omits it).
  The existing `cleanTranscript` still strips special tokens and repetitions.
- Pure audio helpers (PCM conversion, span trimming, language mapping) live in a
  separate module with unit tests.
- `asr-service.ts` never installs the model. `transcribe()` returns
  `model-missing` when `whisper-model` is not ready, holds leases on both assets
  while the worker runs, and keeps the reclaimer, owned-process and generation
  handling. The per-request timeout drops from 5 minutes to 60 seconds because
  downloads no longer happen inside the worker.
- New `chat:asr-warm` IPC starts the worker and loads both models. The renderer
  calls it when recording starts, and once after the model installs.
- New `chat:asr-support` IPC returns `{ supported: true }` or
  `{ supported: false, reason: 'platform' | 'os-version' }`. It is `platform` for
  hosts without a local ML runtime target and `os-version` on macOS older than 15
  (Darwin kernel major below 24). Linux glibc is not probed; an addon load failure
  there surfaces as `unavailable`.
- `chat:transcribe` accepts `{ language }`, validated in main against
  `pt | en | auto`, and returns `{ text }` or `{ error: 'silent' | 'model-missing' | 'unavailable' }`.
- On first start of the new worker, the unused
  `transformers-cache/Xenova/whisper-base` directory is removed once.

### Renderer

- `ChatMicButton` props become `onTranscribed(text)` plus an optional
  `onAutoSend(text): boolean`. With auto-send on, the button calls `onAutoSend`;
  when it returns false (composer disabled or busy), it falls back to
  `onTranscribed`.
- `ChatView` implements `onAutoSend` by joining the current draft and the
  transcription, then calling `submitDraft` with the current mentions; draft
  attachments are sent with it. Queueing and steering during a running turn stay
  as `submitDraft` already handles them. It returns false when `keyMissing`,
  `reviewLoopActive` or `botBlocked`.
- `BotComposer` implements it with `send()` and returns false when `busy` or
  `locked`.
- The microphone menu gains "Send automatically" (switch, stored in
  `chat.mic.autoSend`, absent means on) and a two-option language choice
  (`chat.mic.language`: `app` or `auto`). Both use custom rows like the existing
  hold-to-record switch, never a native `<select>`.
- When the model is not installed, clicking the microphone opens a card: model
  size, "runs entirely on this computer", a Download button, a progress bar driven
  by `runtime-assets:changed`, and Cancel. After install it shows "Preparing…"
  during warm-up, then "Ready".
- Failures are visible. `unavailable` shows an amber state with an explanatory
  tooltip instead of failing silently; `silent` keeps its current behavior.
- All new text goes to the `en` and `pt-BR` chat catalogs.

### Notices and docs

- `THIRD_PARTY_NOTICES.md`: whisper.cpp/ggml through `@fugood/node-whisper-*`
  (MIT), Silero VAD ggml model (MIT), and Whisper large-v3-turbo weights
  (MIT, downloaded on demand).
- `runtime-assets/local-ml/README.md` and user-facing docs describe voice
  dictation, the one-time download, auto-send, and offline preparation.

## Error handling

| Situation | Behavior |
| --- | --- |
| Unsupported system | Microphone disabled with a tooltip naming the requirement (macOS 15 or later, or an unsupported platform). |
| Model not installed | Download card; no recording starts. |
| Download fails, is cancelled, or hash mismatches | Existing runtime-asset states (`failed`, `corrupt`); the card offers Retry. |
| Not enough disk space | Existing disk preflight error in the card. |
| Model file removed or corrupt after install | Asset verification marks it `corrupt`; the card offers Repair. |
| Worker crash or timeout | `unavailable`, amber state; the next dictation restarts the worker. |
| No speech detected | `silent`; nothing is sent or inserted. |
| Auto-send rejected by the composer | Text goes to the draft. |
| Microphone permission denied | Unchanged existing flow. |

## Testing

- Unit: registry entry and `file` format install/verify/remove through the fake
  downloader; downloader host rules for `huggingface.co` and `*.hf.co`; audio
  helpers; `asr-service` returns `model-missing` without starting the worker and
  passes the language; worker idle-stop tests updated to the new init contract;
  `ChatMicButton` auto-send on/off, rejection fallback, model-missing card;
  preload contract snapshot for `chatAsrWarm`.
- Runtime: build, smoke and cross-verify scripts on the local ML archive, including
  the native load and bundled VAD model.
- Acceptance on the owner's Mac: 10 real microphone recordings in pt-BR, including
  single-word replies ("sim", "não", "pode") and technical sentences. Targets:
  technical sentences correct apart from casing and punctuation; short replies
  correct or clearly visible as wrong; under 2 s from stop to message for speech
  up to 10 s; no message from silence or room noise.
- `npm run verify:pr -- --full --package`, because the native runtime and packaging
  change.

## Risks

- Single-word replies were misrecognized with synthesized voices. If real
  recordings confirm it, add a guard that sends very short utterances to the draft
  instead of auto-sending.
- The addon is maintained by a third party. The exact version, lockfile integrity,
  signing and smoke test pin it, and the worker's local interface keeps a
  self-built whisper.cpp as a drop-in replacement.
- Windows and Linux run on CPU and were not measured. Expect several seconds per
  sentence on typical laptops; Vulkan is the follow-up if it is too slow.
- Memory use of the loaded model was not measured; expect several hundred MB above
  the 574 MB file. The existing reclaimer stops the idle worker, and reloading
  takes about 0.3 s once shaders are compiled.
- Dictation stops working on macOS 12–14, where today's `whisper-base` path runs.
  A self-built addon with a lower deployment target would restore it if needed.
- Hugging Face CDN hostnames can change. The downloader allows `*.hf.co`, and a new
  host outside it fails closed with a clear download error.
