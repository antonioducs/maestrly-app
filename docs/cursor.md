# Cursor subscription

Maestrly's desktop chat supports Cursor through the bundled Cursor SDK 1.0.31.
In provider settings, choose **Sign in with Cursor** and complete the browser
sign-in flow. Then choose a discovered Cursor model in the conversation model
picker. Use **Connect another account** to connect another account with its own label.
An eligible Cursor account and an internet connection are required. Available
models and account usage limits come from Cursor.

Cursor is available for chat, Maestro, subagent profiles, and the desktop
executor's provider selection. For platform tasks, enable the Cursor account on
a desktop executor.

The SDK and native helpers ship with the application; installing the Cursor
editor or a separate Cursor CLI is unnecessary. Supported architectures are
macOS arm64/x64, Linux arm64/x64, and Windows x64. The SDK does not publish a
Windows ARM64 helper in this version; Cursor is unavailable on that architecture
while the rest of Maestrly remains usable.

Cursor credentials and conversation state belong to the selected Maestrly
profile. Credentials use the OS-backed secure store; if persistence is unavailable,
the account card indicates that sign-in lasts only for the current session.
Do not copy tokens into project files or commit them. Signing out
removes the integration's saved credential; it does not erase chat history.
See [Local data](local-data.md) before moving or resetting a profile.

Cursor runs use Maestrly's tool permissions and conversation controls. Model
access, authentication errors, rate limits, and service availability are governed
by Cursor. Token usage reported by the SDK is shown when available; remaining
subscription quota is not inferred. If access fails, check the provider status
and sign in again.

Cursor's SDK has its own license and service terms; see
[Third-party notices](../THIRD_PARTY_NOTICES.md).

Developers can run the [packaged and opt-in live checks](development.md#cursor-sdk-packaging-and-checks)
to verify a local build.
