# Maestrly Bot visual integration

The Bot now uses the Maestrly App's SF Pro Text/system stack, warm foreground,
shared Button/Input components, checkbox styling and composer surface.
Pure presentation lives in [the UI package](../packages/ui/README.md); development
app imports retain compatible reexports. The package cannot import privileged or
application code; check:boundaries enforces this.

The Bot's sidebar uses macOS native vibrancy behind a high-opacity surface.
Other platforms have an opaque window fallback. Light, dark and system themes,
reduced motion and reduced transparency are supported. Main conversation surfaces
remain legible independently of the wallpaper.

Onboarding separates destination, computer profile, permissions, network and
consent. Technical resources are collapsed by default and aligned when expanded.
A blocked selection has a contextual alternative. Copy reflects unavailable
administrator actions; no permission or network default is changed by this UI work.
The composer uses circular indigo send, a visible stop action and attachment chips;
removing a chip removes the message reference, not the uploaded workspace file.

Electron tests cover startup/onboarding/login, draft retention through settings,
attachments, cancellation, detail panels, native dialog keyboard containment,
visible keyboard focus, minimum 840×620 window and light/dark appearance.
Computed-color tests require text contrast ≥4.5:1, input boundary contrast ≥3:1,
and sidebar text ≥4.5:1 against a worst-case white backdrop.

Screenshots are generated under apps/bot-desktop/test-results/ and remain outside
Git: ux-first-use, ux-identity, ux-prepare-dark, ux-prepare-light,
ux-prepare-minimum, ux-computer-details, ux-conversation, ux-details,
ux-working, ux-attachment, plus existing activity/approval/error/result captures.
They exercise real Electron rendering with development fixtures, not remote
execution or a usability study with external participants.

This change updates the installed Bot Lab while retaining its profile and previous
application bundle. It does not install or mutate Host code, runtimes or VMs.
