# Local ML runtime and offline models

The runtime is built from the pinned npm lockfile in this directory. RAG uses
Transformers.js, ONNX Runtime, and Sharp; their licenses remain in the archive.
Voice dictation uses the whisper.cpp N-API addon (`@fugood/node-whisper-<platform>-<arch>`,
only the target's package) and the Silero VAD model committed under `models/`,
both archived here. The addon's license texts ship with the app under `licenses/`
because its platform packages contain none; see
[Third-Party Notices](../../../../THIRD_PARTY_NOTICES.md).

## Build and package

Use an official Node.js build that matches `.nvmrc` (nodejs.org installer, nvm, or
fnm), as CI does. The build writes the archive hash into the tracked
`manifest.json`, and gzip output depends on the zlib that compresses it: official
builds bundle their own, while distribution builds such as Homebrew `node` link
the system zlib and produce different hashes. The build and
`npm run check:local-ml-toolchain` refuse a Node.js that uses a shared zlib.

1. Run `npm ci` in the repository root.
2. Run `node scripts/build-local-ml-runtime.mjs` for the host architecture.
3. Run `node scripts/smoke-local-ml-runtime.mjs <archive>` to load the native
   libraries, including the whisper.cpp addon with the bundled VAD model.
4. Run `node scripts/package.mjs prod --mac --arm64` (or `--win --x64`,
   `--linux --x64`, and the appropriate architecture for your host).

The package wrapper performs steps 2 and 3 automatically and embeds one verified
archive. The app installs it into its profile without network access.

Development uses `runtime-assets/local-ml/archives` directly. Rebuild/restart the
app after changing the archive or manifest. Direct `electron-builder` invocation
bypasses staging; use the package wrapper. Do not commit generated archives,
`bundle/`, or this directory's `node_modules/`.

Build on the target OS/architecture. The existing macOS arm64 to Windows x64
cross-build is also supported and checks archive hashes, paths, and PE headers;
it cannot execute Windows native libraries. Other cross-build combinations fail
closed. Native-library availability limits target support: Windows arm64 and Linux
arm64 require compatible upstream ONNX/Sharp binaries and have not been verified.
The desktop packaging configurations still cover macOS, Windows, and Linux.

Initial dependency setup needs access to npm and native dependency download hosts.
An already materialized, matching dependency tree can be rebuilt offline. Transfer
the resulting installer to an offline machine; no npm installation is needed there.

## Prepare models for an offline machine

Models are separate from the runtime archive. When a local AI feature is enabled,
Transformers.js can fetch its models directly from Hugging Face, caching them under
`<profile>/transformers-cache`. To prepare them explicitly on a connected machine:

```sh
node scripts/build-local-ml-runtime.mjs
node scripts/prepare-local-ml-models.mjs --cache-dir /path/to/model-cache
node scripts/prepare-local-ml-models.mjs --cache-dir /path/to/model-cache --offline
```

The second command downloads and loads `Xenova/all-MiniLM-L6-v2` for RAG; the
third checks that it loads with remote model access disabled. Copy the **contents**
of that cache into the target profile's `transformers-cache` directory before
enabling local AI. Preserve subdirectories. Models follow the upstream default
revision; review upstream model licenses before redistributing a prepared cache.
Missing model files require connected setup again.

The dictation model is not a Transformers.js model. It is the `whisper-model`
runtime asset: `ggml-large-v3-turbo-q5_0.bin` (574,041,195 bytes, SHA-256
`394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2`), pinned to a
fixed Hugging Face revision and installed only when the user clicks Download from
the microphone or in Settings › Maestrly Chat › Components. To prepare an offline machine, install
it on a connected machine with the same operating system and architecture, then
copy that profile's whole `runtime-assets/whisper-model` directory into the
target profile's `runtime-assets` directory while Maestrly is closed. The app
verifies the copied file against its install marker and the pinned hash before
using it; copying only the `.bin` file is not recognized.

Profiles are `maestrly-app`, `maestrly-app-beta`, and `maestrly-app-dev` under the OS
application-data directory; dev instances append their instance ID. Each running
channel opens only its own profile.

Optional Codex, Copilot, and tunnel setup use their direct upstream sources.
Provider credentials and internet access are only needed when using those providers.
