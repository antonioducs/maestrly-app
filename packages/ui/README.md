# Maestrly UI

Shared presentation primitives for the desktop applications. This package has no
Electron, Node, provider, storage or application imports.

The original desktop Button and Input paths reexport these exact components.
Their Tailwind variants, native props and forwarded refs are preserved.
ComposerSurface owns the shared composer geometry; each application supplies its
own editor, attachment UI, send/cancel handlers and other slots. It does not own
tasks, permissions or drafts.

- tokens.css: Maestrly font stack, warm foreground, surfaces and accent tokens.
- checkbox.css: extracted native checkbox styling from Maestrly App.
- controls.css: plain-CSS rendering of controls scoped to .maestrly-ui.
- Button, Input, Checkbox, Select, Textarea and Surface: presentation only.

The development app keeps its Tailwind pipeline and explicitly scans this source
package with @source. The Bot imports the plain CSS and supplies its light/system
theme mappings. There are no remote fonts or icon downloads.

Validation: npm run check:ui; desktop shared-ui.test.ts; Bot Electron appearance,
onboarding and chat suites. Components are exported as source for Vite/esbuild.
