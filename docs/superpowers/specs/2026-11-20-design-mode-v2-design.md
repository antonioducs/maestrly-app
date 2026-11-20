# Design mode v2 — design

## Goal

Make Design mode cheaper and more consistent, and give its prototypes the review surface of a design tool:

1. Prototypes start from the workspace's design system instead of inventing tokens and components each time.
2. Prototypes are published as artifacts, so other people can open, comment on and review them, and agents iterate
   from those comments with exact edits.
3. Verification has a budget instead of an open loop of screenshots and snapshots.
4. Every prototype ends with a handoff that a cheaper model can implement from.
5. The artifact viewer gains design-tool features for prototypes that follow the contract below: **Inspect** (select an
   element and see its component, props and tokens, go to its main component, count its uses), **Board** (every
   screen side by side) and **Tokens** (change a token and see every screen update, then save it as a new version or
   suggest it in a comment).
6. Usage is recorded per chat mode, so the cost of Design mode can be measured.

## Decisions

| Topic | Decision |
| --- | --- |
| Format | Prototypes stay HTML, CSS and JavaScript. No vector editor and no external design tool; the viewer reads the contract below. |
| Design system | A per-workspace package in `design/` at the repository root (or the frontend's root in a monorepo). Design mode reads it before designing; when it is missing and the project has an interface, the first prototype extracts it from the real code; when there is no interface, the chosen direction becomes the package. |
| Contract | A prototype that wants the viewer features ships `maestrly-design.json`, its tokens as CSS custom properties in a tokens file, components marked with `data-ds`, and a URL for every screen and state. Pages without the contract keep working; the viewer then offers only computed styles. |
| Publishing | When the artifact tools are advertised, Design mode publishes the prototype folder with `artifact_create`, iterates with `artifact_update`, and reads feedback with `artifact_comments` when asked. The local folder stays the source of truth. Without a bot server, it keeps today's local preview. |
| Verification | One desktop and one mobile screenshot of the main flow, snapshots only to interact, console checked once, a written self-critique, and one fix-and-recheck pass. More only for a real blocker. |
| Handoff | `HANDOFF.md` in the prototype folder (and the artifact): screens and states with their URLs, components and their real-code counterparts, tokens, working versus mocked behavior, and open questions. |
| Token edits | Previewed live in the viewer without a model. The owner saves them as a new version that changes only the tokens file; anyone else who can comment sends them as a suggestion attached to a comment, which the owner or an agent applies. |
| Cost measurement | The chat mode is recorded with each usage ledger entry. |

## Workspace design system package

```text
design/
├── DESIGN.md        required: direction and rules for agents
├── tokens.css       required: semantic tokens as CSS custom properties
├── components.html  required: every reusable component and its variants, rendered with tokens.css
├── USAGE.md         optional: read order, composition rules, mapping to real code components
└── design.json      required: manifest
```

`design.json`:

```json
{
  "schema": "maestrly-design-system/v1",
  "name": "Maestrly desktop",
  "description": "One sentence.",
  "tokens": "tokens.css",
  "components": "components.html",
  "source": { "kind": "extracted", "from": ["apps/desktop/src/renderer/styles.css"] },
  "componentMap": { "Button": "apps/desktop/src/renderer/components/ui/button.tsx" }
}
```

- `source.kind` is `extracted` (derived from real code, which stays the source of truth) or `authored` (the package is
  the source of truth).
- `componentMap` is optional and maps each component name to the real implementation, for the handoff.
- `DESIGN.md` covers at least: direction, color, typography, spacing and layout, shape and elevation, motion,
  components, accessibility, and voice and microcopy, each with concrete do and don't rules.
- `tokens.css` declares tokens on `:root`, with optional theme blocks (`[data-theme="dark"]`, `.theme-light`). Names
  are semantic and grouped by prefix: `--color-*`, `--font-*`, `--text-*` (sizes and line heights), `--space-*`,
  `--radius-*`, `--shadow-*`, `--duration-*`, `--ease-*`. Other prefixes are allowed and grouped as "Other".
- `components.html` renders each main component once with `data-ds="Name" data-ds-main`, then its variants with
  `data-ds-props`. It loads `tokens.css` and uses only tokens for design values.

## Prototype contract

A prototype folder (and the artifact published from it) contains:

```text
prototypes/<slug>/
├── maestrly-design.json   manifest
├── tokens.css             copy of design/tokens.css, the only file token edits change
├── components.html        copy or subset of design/components.html (optional)
├── index.html             the prototype
├── HANDOFF.md             handoff
└── …
```

Artifacts must be self-contained, so the design system files are copied in, not linked.

`maestrly-design.json`:

```json
{
  "schema": "maestrly-prototype/v1",
  "title": "Orders",
  "tokens": ["tokens.css"],
  "components": "components.html",
  "screens": [
    { "id": "dashboard", "name": "Dashboard", "path": "index.html#/dashboard", "viewport": "desktop" },
    { "id": "order-empty", "name": "Order · empty", "path": "index.html#/orders/new?state=empty", "viewport": "mobile" }
  ],
  "componentTokens": { "Button": ["--color-accent", "--radius-md", "--text-sm"] }
}
```

| Field | Rule |
| --- | --- |
| `schema` | Exactly `maestrly-prototype/v1`. |
| `title` | Optional string, at most 120 characters. |
| `tokens` | 1 to 8 relative paths of CSS files in the artifact. The first one is where token edits are saved. |
| `components` | Optional relative path of the components page. |
| `screens` | 1 to 50 entries. `id` matches `^[a-z0-9][a-z0-9-]{0,47}$` and is unique; `name` is at most 80 characters; `path` is a relative path of an HTML file in the artifact, optionally followed by `?query` and `#fragment`, at most 300 characters; `viewport` is `desktop` (1440×900), `tablet` (834×1112), `mobile` (390×844) or `{ "width": 320–2560, "height": 320–2560 }`. |
| `componentTokens` | Optional. Component name to the tokens it uses, as a hint for Inspect when stylesheets cannot be read. |

Markup:

- `data-ds="Button"` marks the root element of a component instance. Names match `^[A-Z][A-Za-z0-9]{0,47}$`.
- `data-ds-props="variant=primary size=md"`: space-separated `key=value` pairs, at most 200 characters, keys matching
  `^[a-z][a-zA-Z0-9-]{0,31}$` and values without spaces.
- `data-ds-main` marks the main component definition, in `components.html`.
- Local stylesheets are linked with `<link rel="stylesheet" href="…" crossorigin>` so Inspect can read `sheet.cssRules`
  inside the sandboxed opaque (`"null"`) origin; verified in Chromium that omitting `crossorigin` throws `SecurityError:
  Cannot access rules` even when the response carries `Access-Control-Allow-Origin: *` (`<style>` blocks and
  `componentTokens` + `getComputedStyle` remain available as fallback).
- Every screen and every state named in `screens` is reachable by its URL alone: hash routes or query parameters that
  the prototype reads on load and on `hashchange`. Primary flows never depend on state that exists only in memory.
- Styles use `var(--token)` for every design value that the tokens file defines; no hard-coded duplicates.

Limits shared by the host, bridge and viewer: 200 tokens per artifact, token names matching
`^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`, token values at most 200 characters without `;`, `{`, `}`, `<`, `\`, `/*`, `*/`, `!important`, newlines, `url(`, `image-set(`, `-webkit-image-set(`, or `src(`.

## Viewer features

These apply to page artifacts whose current version has a valid `maestrly-design.json`. Whiteboards are unchanged.

- **Inspect**: a mode like Comment. Pointing highlights the nearest `[data-ds]` element (or the element under the
  pointer when there is none); clicking selects it and opens a panel with the component name, whether it is the main
  component or an instance, its props, the tokens it uses with their current values, and a few computed styles (font,
  size, color, background, radius, padding). **Go to main component** opens `components.html` and reveals the
  `data-ds-main` element; the main component shows how many instances each screen has. Escape leaves the mode.
- **Board**: every screen of the manifest at its viewport size, scaled to fit, side by side on a pannable and
  zoomable surface with each screen's name. Selecting a screen focuses it; opening it shows it in the normal page
  view. Frames load lazily and only a few stay live at once.
- **Tokens**: a panel listing the tokens of the first tokens file, grouped by prefix, with an editor fitting each value
  (color, length, number, text). A change previews immediately in every open frame and shows the list of changes.
  The owner can **Save as new version** (the host rewrites only those declarations in the tokens file and creates a
  version whose summary lists them) or discard. Others who can comment can **Suggest**, which creates a comment with
  the changes attached; the owner can apply a suggestion from the viewer, and agents read it through
  `artifact_comments`.
- Without the contract, Inspect still selects elements and shows computed styles; Board and Tokens are hidden.

## Security

The page stays untrusted. Inspect, inventory and token preview extend the bridge protocol in
`packages/artifact-host/src/shell/contract.ts`: every message keeps being parsed with fixed shapes and capped strings,
and what the shell sends in stays limited to the page's own content (token names and values the host read from the
artifact's own files, or values the person typed). Token preview must not let the shell inject arbitrary CSS or markup;
values are validated against the limits above before they reach the page. Saving a version from the viewer is an owner
capability; suggestions follow the comment permissions. The full analysis is in the technical design below.

## Technical design

### 1. Manifest and token parsing

#### Host module and lifecycle

Manifest and token handling lives in `packages/artifact-host/src/design.ts` (`DesignService`), shared by `PublicServer`
and `CommentService`.

- **Non-blocking publication**: `artifact_create` and `artifact_update` do not reject bundles whose
  `maestrly-design.json` is absent or malformed. A prototype in progress still publishes and opens as a normal page;
  when `maestrly-design.json` or its referenced files fail validation, `DesignService` resolves that version's design
  metadata to `null` (Inspect falls back to computed styles; Screens and Tokens stay hidden). Write endpoints that
  depend on the contract (`POST /a/:id/api/tokens`, `POST /a/:id/api/comments` with `suggestion`, and
  `POST /a/:id/api/comments/:id/apply`) require a non-null contract on the target version and answer `409`
  (`no_design_contract`) otherwise.
- **Dedicated viewer endpoint (`GET /a/:id/api/design?version=<n>`)**: `GET /a/:id/api/state` stays synchronous on
  SQLite because it is also polled every 30 seconds (`REPLACED_CHECK_MS`) and called by offscreen thumbnail captures.
  Design metadata requires reading blobs asynchronously and varies per version when stepping through history, so the
  viewer fetches `GET /a/:id/api/design?version=<n>` (`viewerOnly: true`, requiring `x-maestrly-artifact: 1`, session
  access, and `seesHistory` when `version !== currentVersion`) in parallel with `POST /a/:id/api/frame`. For whiteboards
  and versions without a valid contract, it returns `200 { "design": null }`.
- **Per-version cache**: Because stored artifact versions are immutable, `DesignService` caches resolved
  `ViewerDesign | null` values in an in-memory LRU map keyed by `${artifactId}:${version}` capped at
  `MAX_DESIGN_CACHE_ENTRIES = 64` (evicting entries for `artifactId` on `delete`). Token writes always re-read the raw
  `tokens[0]` blob inside `admin`'s exclusive write queue rather than trusting cached text.

#### Manifest validation (`maestrly-design.json`)

`DesignService` looks up exact bundle path `maestrly-design.json` in `version_files`. If missing or larger than
`MAX_MANIFEST_BYTES = 64 * 1024` (64 KiB), the version has no contract. Otherwise it parses UTF-8 JSON with Zod:

- `schema`: `z.literal('maestrly-prototype/v1')`.
- `title`: `z.string().trim().min(1).max(MAX_TITLE_CHARS).optional()` (optional so manifests matching either the JSON
  example or the field table above validate).
- `tokens`: 1 to 8 unique entries; each must pass `normalizeBundlePath`, end in `.css`, and exist in that version's
  `version_files`.
- `components`: optional; when present, must pass `normalizeBundlePath`, satisfy `isHtmlPath`, and exist in that
  version's `version_files`.
- `screens`: 1 to 50 entries with unique `id` matching `^[a-z0-9][a-z0-9-]{0,47}$`, single-line `name` (`1..80` chars,
  `/^\P{Cc}+$/u`), `viewport` (`'desktop' | 'tablet' | 'mobile' | { width: 320..2560, height: 320..2560 }`), and `path`
  (`1..300` chars, `/^\P{Cc}+$/u`). `path` splits via `/^([^?#]+)(\?[^#]*)?(#.*)?$/` into `filePath`, `query`, and
  `fragment`; `filePath` must pass `normalizeBundlePath`, satisfy `isHtmlPath`, and exist in that version's
  `version_files`.
- `componentTokens`: optional map of at most `MAX_DESIGN_COMPONENTS = 200` keys matching
  `^[A-Z][A-Za-z0-9]{0,47}$`, each mapping to at most `MAX_DESIGN_TOKENS = 200` unique token names matching
  `TOKEN_NAME_PATTERN`.

#### Token declaration scanner (`tokens[0]`)

`tokens[0]` must be valid UTF-8 of at most `MAX_TOKENS_FILE_BYTES = 256 * 1024` (256 KiB). `parseTokensCssWithSpans`
scans it in a single `O(N)` character pass (no regex backtracking) while recording exact UTF-16 code-unit spans
(`blockStart`, `blockEnd`, `declStart`, `declEnd`, `valueStart`, `valueEnd`, `hadImportant`):

1. **Comments, strings, and parentheses**: `/* ... */` comments outside quotes are skipped while preserving character
   indices; `'...'` and `"..."` strings and nested `(...)` groups keep `;`, `{`, `}`, and `:` inside values from
   splitting declarations or blocks prematurely.
2. **Rule scopes (`:root` and theme blocks)**:
   - Style rules at top level, inside `@layer ... { ... }`, and inside
     `@media (prefers-color-scheme: dark | light) { ... }` are inspected; `@keyframes`, `@font-face`, and other
     at-rules are skipped.
   - Each rule's selector (comments stripped, whitespace collapsed) is classified into:
     - **Base scope (`theme: null`)**: `:root` (or a selector list of `:root` / `html` / `:host` containing `:root`,
       outside `@media`), or
     - **Theme scope (`theme: string`)**: matches the closed theme-selector allowlist:
       - `^(?::root|html)?\[data-theme=["'][a-zA-Z0-9_-]{1,32}["']\]$` (for example `[data-theme="dark"]` or
         `[data-theme='dark']`),
       - `^(?::root|html)?\.(?:dark|light|theme-[a-zA-Z0-9_-]{1,32})$` (for example `.theme-light` or `.dark`), or
       - `@media (prefers-color-scheme: dark)` / `@media (prefers-color-scheme: light)` wrapping `:root`.
   - Component or arbitrary selectors in `tokens[0]` are ignored, ensuring theme selectors echoed into preview
     stylesheets can never carry arbitrary CSS selectors.
3. **Declarations, duplicates, and limits**:
   - Inside a recognized scope, declarations whose property matches
     `TOKEN_NAME_PATTERN = /^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,61}$/` (`<= 64` chars total) are parsed. A trailing
     `!important` is stripped from the exposed value (`valueStart..valueEnd` covers only the value before any
     `!important` and trailing whitespace) while `hadImportant` remembers whether `!important` was present in source.
   - Values must validate under `isValidTokenValue`: trimmed length `1..200`, single-line (`/^\P{Cc}+$/u`), containing
     no raw `<`, `\`, `/*`, or `*/`, with balanced `"`/`'` string quotes, no unquoted `;`, `{`, or `}`, balanced `()`
     and `[]` outside quotes, and no unquoted `!important`, `@import`, or case-insensitive external/script functions
     `/(?:url|-webkit-image-set|image-set|src|expression)\s*\(/i` (blocking CSS Images 4 bare-string
     `image-set("https://...")` in addition to `url(`). Invalid declarations are skipped.
   - **Duplicates**: within the same `(name, theme)` scope, CSS cascade order applies—the **last** valid declaration in
     file order wins both for the value shown in the viewer and as the target span rewritten on save; earlier shadowed
     duplicates remain untouched.
   - **Canonical list**: tokens declared in the base `:root` scope form the ordered token list, capped at
     `MAX_DESIGN_TOKENS = 200` (declarations beyond 200 are ignored). Matching declarations in theme scopes populate
     `token.themes[theme]` for tokens present on `:root`.

#### Grouping and editor value classification

Shared pure helpers in `packages/artifact-host/src/shell/design-model.ts` classify each token deterministically:

- **Prefix group (`TokenGroup`)**: `--color-*` → `'color'`, `--font-*` → `'font'`, `--text-*` → `'text'`,
  `--space-*` → `'space'`, `--radius-*` → `'radius'`, `--shadow-*` → `'shadow'`, `--duration-*` → `'duration'`,
  `--ease-*` → `'ease'`, everything else → `'other'`.
- **Editor kind (`TokenValueKind`: `'color' | 'length' | 'number' | 'text'`)**:
  1. `var(...)`, `calc(...)`, `clamp(...)`, `min(...)`, `max(...)` always classify as `'text'` so editing does not
     silently destroy CSS expressions or aliases.
  2. `'color'`: hex `#RGB`/`#RGBA`/`#RRGGBB`/`#RRGGBBAA`, functional
     `rgb()`/`rgba()`/`hsl()`/`hsla()`/`hwb()`/`lab()`/`lch()`/`oklab()`/`oklch()`/`color()`/`color-mix()`, or CSS
     named colors/`transparent`/`currentColor` when `group === 'color'`.
  3. `'length'`: single numeric value with a spatial `<length-percentage>` unit
     (`/^[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|dvh|dvw|svh|svw|ch|ex|lh|rlh)$/i`), plus bare `0` when
     `group` is `'space'` or `'radius'`. Time (`150ms`, `0.2s`), multi-value shorthands (`8px 12px`), and easing curves
     stay `'text'` so a length control never corrupts units.
  4. `'number'`: bare finite decimal `/^[+-]?(?:\d+\.?\d*|\.\d+)$/` (such as `font-weight: 600` or `line-height: 1.5`).
  5. `'text'`: everything else.

---

### 2. Bridge protocol and stylesheet experiment

#### Experimental verification of CSSOM access in opaque-origin frames

Verified with headless Chromium against an HTTP server reproducing the exact `shellHeaders`, `contentHeaders`
(`sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox` and
`Access-Control-Allow-Origin: *`), and `<iframe sandbox="...">`:

| Mechanism inside the sandboxed frame (`window.origin === "null"`) | Result |
| --- | --- |
| `<link rel="stylesheet" href="tokens.css">` (standard, no `crossorigin`) | Reading `sheet.cssRules` throws `SecurityError: Cannot access rules`. Without `crossorigin`, `<link>` performs a `no-cors` fetch that is cross-origin relative to `"null"`, leaving the `CSSStyleSheet` origin-unclean despite `Access-Control-Allow-Origin: *`. |
| `<link rel="stylesheet" href="tokens.css" crossorigin>` | `sheet.cssRules` is readable (CORS mode succeeds against `Access-Control-Allow-Origin: *`). |
| Inline `<style>…</style>` | `sheet.cssRules` is readable. |
| `getComputedStyle(el).getPropertyValue('--color-accent')` | Returns the live resolved token value (`"#2563eb"`). |
| `new CSSStyleSheet()` + `document.adoptedStyleSheets` | Supported in `"null"` origin; updates computed styles immediately without mutating DOM nodes. |

#### Fallback chain for an inspected element's used tokens

Note that `getComputedStyle(el)` alone cannot discover *which* tokens an element references: custom properties inherit
from `:root` onto every element, and standard computed properties (`color`, `padding`) return already-resolved values
(`rgb(...)`, `12px`) rather than `var(--...)`. When an element (and its nearest `[data-ds]` ancestor, if any) is
picked in Inspect mode, the bridge and shell combine three layers:

1. **Readable CSSOM rules + inline `style` (bridge)**: `bridge.ts` walks `document.styleSheets`, wrapping each
   `sheet.cssRules` read in `try/catch` (covering inline `<style>` and any `<link crossorigin>` sheets, up to
   `MAX_SCANNED_RULES = 2000` rules, descending into matching `@media` and `@layer` rules). For every rule whose
   selector matches the hit element or its `[data-ds]` root, plus their `style` attributes, it extracts referenced
   `var(--name)` identifiers.
2. **Manifest `componentTokens` hint (shell → bridge)**: When entering Inspect mode, the shell passes the version's
   validated `manifest.componentTokens` map (derived solely from the artifact's own `maestrly-design.json`, never user
   data). When the inspected element has `data-ds="Name"`, the bridge unions `componentTokens["Name"]` with the CSSOM
   set, covering external `<link rel="stylesheet">` files that omit `crossorigin`.
3. **Live value resolution via `getComputedStyle` (bridge)**: For each collected token name (deduplicated, capped at
   `MAX_INSPECT_TOKENS = 64`), the bridge reads `getComputedStyle(target).getPropertyValue(name).trim()` on the
   inspected element so element-local or subtree `[data-theme]` values and active previews are reflected accurately.
   Without a design contract, `componentTokens` is empty and Inspect reports inline/readable `var(--*)` tokens (if any)
   alongside computed styles.

#### Protocol additions (`contract.ts` / `bridge.ts`)

- `FORWARDED_KEYS` becomes `['Escape', 'c', 'f', 'i'] as const` so the shell can toggle Inspect with `i` when focus is
  inside a frame (unless `data-maestrly-shortcuts="none"`).
- Inspect mode and Comment mode are mutually exclusive in the shell. While `inspecting === true`, `bridge.ts`
  intercepts capture-phase pointer and click events with the same blocker as Comment mode so clicking links or buttons
  selects them instead of navigating or firing page handlers. Hover and selection outlines are drawn in the viewer
  shell's overlay above the iframe—never inside the page.
- `layout` gains optional `inspectRect?: SelectionRect | null` so scrolling or resizing inside the frame keeps the
  selected element's overlay box aligned at 60 fps without re-scanning stylesheets on every scroll event.

New `ShellMessage` variants (shell → frame, `{ source: 'maestrly-shell', ... }`):

- `{ type: 'inspect-mode'; inspecting: boolean; componentTokens?: Record<string, string[]> }` — toggles Inspect mode;
  turning it off clears the frame's hover/selection tracking.
- `{ type: 'inspect-clear' }` — clears the currently inspected element while staying in Inspect mode.
- `{ type: 'reveal-component'; component: string }` — locates `[data-ds="<component>"][data-ds-main]` (falling back to
  `[data-ds="<component>"]`), scrolls it smoothly into view, selects it as the inspected element, and replies with
  `inspect-pick` (`target: null` when absent).
- `{ type: 'inventory-request'; requestId: string }` — asks the frame to count `[data-ds]` elements currently in its
  DOM (up to `MAX_INVENTORY_NODES = 5000`), separating instances (`:not([data-ds-main])`) from `[data-ds-main]`
  definitions.
- `{ type: 'token-preview'; tokens: TokenChange[] }` — applies live custom-property overrides via `adoptedStyleSheets`,
  then re-measures layout and re-emits `inspect-pick` if an element is currently selected.
- `{ type: 'token-preview-clear' }` — empties the preview stylesheet and re-measures.

New `BridgeMessage` variants (frame → shell, `{ source: 'maestrly-bridge', ... }`), strictly validated in
`parseBridgeMessage`:

- `{ type: 'inspect-hover'; target: InspectHover | null }` — throttled to once per animation frame during
  `pointermove` (resolving `hit.closest('[data-ds]') ?? hit`), and `null` on `pointerleave`.
- `{ type: 'inspect-pick'; target: InspectTarget | null }` — emitted on `click` in Inspect mode, on
  `reveal-component`, and after `token-preview` / `token-preview-clear` when an element is selected.
- `{ type: 'inventory'; requestId: string | null; instances: Record<string, number>; mains: string[] }` — answers
  `inventory-request` (`parseBridgeMessage` validates `requestId`, caps keys at `200` matching
  `^[A-Z][A-Za-z0-9]{0,47}$`, and requires integer counts `0..10_000`).

Every parsed object in `contract.ts` builds fresh records without copying `__proto__`, `constructor`, or `prototype`,
validates `data-ds` (`^[A-Z][A-Za-z0-9]{0,47}$`), `data-ds-props` (`<= 32` entries, keys `^[a-z][a-zA-Z0-9-]{0,31}$`,
values `1..120` chars without whitespace), `selector` (`1..300` chars), finite `SelectionRect`, `styles` fields (`<= 120`
chars each), and `tokens` (`<= 64` entries with valid `--*` names and `<= 200`-char values).

#### Applying token previews safely and `bridge.ts` DOM invariant

`bridge.ts` keeps a second constructable `CSSStyleSheet` (`previewSheet`) appended after its highlight/cursor sheet in
`document.adoptedStyleSheets`. On `token-preview`, `bridge.ts` independently re-validates every `{ name, value, theme }`
against `TOKEN_NAME_PATTERN`, the theme-selector allowlist, and the forbidden-character/function rules before grouping
declarations into `:root{--name:value !important;...}` and optional `<theme>{--name:value !important;...}` (or
`@media (prefers-color-scheme: ...){:root{...}}`) and calling `previewSheet.replaceSync(css)`. On `token-preview-clear`,
it calls `previewSheet.replaceSync('')`.

The header comment in `packages/artifact-host/src/shell/bridge.ts` replaces `"Nothing here changes the page's DOM..."`
with:

```ts
// Nothing here mutates the page's DOM tree (no elements, attributes or text nodes are added, edited or removed):
// the active passage is painted with the CSS Custom Highlight API, inspect outlines are drawn by the shell above the
// frame, and cursors and live token previews are applied only through constructable stylesheets in
// `document.adoptedStyleSheets` built from validated custom-property declarations. Keeping the DOM untouched preserves
// CSS selector stability (`pathOf`), text-quote offsets (`indexText`), MutationObserver quiescence, and prototype
// scripts that traverse their own markup.
```

---

### 3. Screens view (`shell/screens.ts`) and frame management

Internal code uses `screens` (`shell/screens.ts`, `DesignView = 'page' | 'screens'`) because `shell/board.ts` already
owns whiteboard synchronization; user-facing labels follow the UX prototype.

- **Capability reuse and URL construction**: `POST /a/:id/api/frame` returns `{ url: '/c/<cap>/<entry>', expiresAt }`,
  where `<cap>` is an HMAC grant bound to `(artifactId, version, sessionId, expiresAt)` (`capability.ts`), and
  `contentHeaders` scopes CSP to the entire `/c/<cap>/` directory. `DesignController` caches `{ capabilityBase:
  '/c/<cap>/', expiresAt }` per version and derives each screen's frame URL (and `manifest.components` URL) via
  `screenFrameUrl(capabilityBase, path)`: splitting `path` into `filePath`, `?query`, and `#fragment`, validating
  `filePath` segments, percent-encoding each path segment, and appending `query` + `fragment`. If `Date.now() >=
  expiresAt - 60_000` when a frame is about to load, `DesignController` refreshes `POST frame` first.
- **Sandbox**: Every screen iframe uses the exact `CONTENT_SANDBOX` and `referrerpolicy="no-referrer"` of the main
  stage iframe.
- **Lazy loading and live frame pool**:
  - At most `MAX_LIVE_SCREEN_FRAMES = 6` screen iframes exist at once in `screens` view, and at most
    `MAX_CONCURRENT_FRAME_LOADS = 2` frames may be in their initial loading state simultaneously (before `ready` or a
    5-second fallback timeout) to avoid main-thread spikes on 50-screen manifests.
  - Pure `selectLiveScreens` in `design-model.ts` ranks screens by: (1) currently focused screen (pinned), (2) screens
    intersecting the visible pan/zoom viewport ordered by distance to viewport center, and (3) LRU of previously loaded
    screens up to `MAX_LIVE_SCREEN_FRAMES`.
  - Unmounted screens render lightweight sized cards (`resolveScreenViewport`: `1440×900`, `834×1112`, `390×844`, or
    custom `width×height`). When a frame is evicted, `DesignController` sets `iframe.src = 'about:blank'`, removes it
    from the DOM, and deletes it from the registry so its browsing context is reclaimed immediately.
  - When a newly mounted screen frame emits `{ type: 'ready' }`, `DesignController` immediately posts the active
    `token-preview` (if any) and an `inventory-request` if that screen's component counts are not cached yet.
  - `requestInventory()` progressively measures unmeasured screens on demand while respecting `MAX_LIVE_SCREEN_FRAMES`
    and `MAX_CONCURRENT_FRAME_LOADS`, marking queued/loading screens with `measuring: true` in `ScreenUsage` and
    publishing per-screen counts incrementally as each `inventory` response arrives.
- **Frame routing (`event.source`)**: `viewer.ts` replaces its single-frame `event.source !== frame.contentWindow`
  check with a `FrameRegistry` scanning connected iframes (`el.isConnected && el.contentWindow === event.source` across
  at most `1 + 6` frames):
  - `{ kind: 'stage' }` routes to `comments`, `responses`, `board` (whiteboard), and `design`.
  - `{ kind: 'screen', screenId }` routes only to `design` (`ready`, `inventory`, `key: 'Escape'`, and per-screen
    `error` status). Background screen frames never move comment pins, never open guest-name prompts on
    `response-submit`, and never trigger global error toasts.

---

### 4. Saving tokens as a new version

- **Endpoint**: `POST /a/:id/api/tokens` in `packages/artifact-host/src/http/design-routes.ts` (with `await found.handle(ctx)`
  in `http/server.ts` so async route rejections always reach the top-level error boundary).
- **Authentication and CSRF**: Enforced by `handleApi` (`Host` allowlist via `allowedOrigin`, exact
  `Origin === origin`, `x-maestrly-artifact: 1`, `Content-Type: application/json`, and `HttpOnly; SameSite=Strict`
  cookie scoped to `/a/<id>/api`) plus `ctx.access?.kind === 'owner'` (`403` for non-owners; `404` without access).
- **Request and concurrency**:
  - Body: `{ baseVersion: number, changes: { name: string, value: string, theme?: string | null }[] }` (`1..200` unique
    `(name, theme ?? null)` entries, each passing `isValidTokenName`, `isValidTokenValue`, and `isValidThemeSelector`).
  - If `baseVersion !== ctx.currentVersion`, responds `409 { error: 'version_conflict', currentVersion }` (matching
    `artifact_update`).
  - Requires a valid design contract on `baseVersion` (`409 no_design_contract`), every target `(name, theme)` present
    in `tokens[0]` (`400 unknown_token`), and at least one value differing from `tokens[0]` (`400 no_changes`).
- **Exact declaration rewrite via `edits.ts` and `admin.update`**:
  - `buildTokenEdits(tokenFile, sourceText, changes)` re-parses `sourceText` with `parseTokensCssWithSpans`, locates
    the winning declaration span `[valueStart, valueEnd]` for each changed `(name, theme)`, and replaces only those
    value characters—preserving comments, indentation, whitespace after `:`, trailing `!important` if originally
    present, and untouched declarations byte-for-byte.
  - Because `applyEdits` in `packages/artifact-host/src/edits.ts` requires each `oldText` to occur **exactly once** in
    the file and `updateArtifactInput` caps `edits` at `MAX_EDITS = 100`, `buildTokenEdits` expands an edit's slice to
    its `[declStart, declEnd]` first; if that substring appears more than once (for example identical `--color-bg:
    #ffffff` in `:root` and `.theme-light`) or if more than `MAX_EDITS` declarations changed, it merges/expands spans
    to their enclosing `[blockStart, blockEnd]` (and, if identical selector blocks still collide, backward to a unique
    prefix) while still mutating only the changed `[valueStart, valueEnd]` slices.
  - Calls `admin.update({ id, baseVersion, summary, createdBy: 'owner', change: { kind: 'edits', edits } })`, reusing
    `admin`'s `exclusive` write queue, `MAX_VERSIONS_PER_ARTIFACT` (`200`), `quotaBytes`, blob deduplication, and
    `onChange` event emission.
- **Summary, response, and rate limit**:
  - `formatTokenSummary` generates `Tokens: --color-accent #2563eb → #ef4444, --radius-md 6px → 8px` (including
    `[theme]` when `theme !== null` and appending `(+N more)` so length stays `<= MAX_SUMMARY_CHARS = 500`).
  - Adds a dedicated `tokenSave: 20` requests/minute scope in `http/rate-limit.ts` (per artifact and session) alongside
    the standard `host`/`artifact`/`session` limits so rapid saves cannot exhaust the 200-version cap.
  - Returns `201 { version: ViewerVersion, design: ViewerDesign }`.

---

### 5. Token suggestions on comments

- **Storage and schema migration (`SCHEMA_VERSION = 5`)**:
  - Stored as a structured nullable JSON column `suggestion_json TEXT` on `comments` in
    `packages/artifact-host/src/store/db.ts`, with migration `5: ALTER TABLE comments ADD COLUMN suggestion_json TEXT;`.
    Keeping suggestions structured avoids parsing untrusted comment prose as CSS edits and separates human discussion
    from machine-validated token diffs.
  - Stored and returned shape (`TokenSuggestion` in `contract.ts` / `comments.ts`):
    ```ts
    export interface TokenSuggestionChange {
      name: string
      from: string
      to: string
      theme?: string
    }
    export interface TokenSuggestion {
      file: string
      changes: TokenSuggestionChange[]
      appliedVersion: number | null
    }
    ```
  - On `POST /a/:id/api/comments`, the caller may pass `suggestion: { changes: TokenChange[] }` (`1..200` items) only
    on a new thread (`parentId` absent; replies with `suggestion` fail with `400 invalid_comment`). The host loads
    `version`'s design contract, verifies every `(name, theme)` exists in `tokens[0]` with `value !== current`, and
    records `file: manifest.tokens[0]`, `from: current`, `to: value`, and `appliedVersion: null` from its own stored
    file—never trusting client-supplied `file` or `from`.
  - `body` keeps its `1..4000` character rule (`commentBody`); when a commenter submits a suggestion without typing a
    note, the viewer supplies a concise default summary (`formatTokenSummary`), which also keeps the comment meaningful
    on older clients.
- **Permissions**: Same `writer(ctx)` rules as comments (`sharing.commentsEnabled === true`, valid viewer session,
  guest has set a name, version not replaced for non-history viewers, `MAX_COMMENTS_PER_ARTIFACT = 2000`). When
  comments are disabled, **Suggest** is hidden in the viewer and `POST comments` returns `403 comments_disabled`.
- **Owner apply (`POST /a/:id/api/comments/:id/apply`)**:
  - `COMMENT_API` in `http/server.ts` extends to `(?:\/(replies|resolve|apply))?`.
  - Requires `ctx.access?.kind === 'owner'`, CSRF headers, and `{ baseVersion }` matching `ctx.currentVersion` (`409
    version_conflict` otherwise).
  - Refuses comments without a suggestion (`400 invalid_comment`) or with `suggestion.appliedVersion !== null` (`409
    already_applied`).
  - Loads `currentVersion`'s `tokens[0]`: verifies every suggested `(name, theme)` still exists and its current value
    is either `change.from` or `change.to` (returning `409 suggestion_conflict` if a newer version changed that same
    token to a third value, while allowing apply across intermediate versions that touched other files or other
    tokens). If at least one token still equals `change.from`, creates a new version via `admin.update`
    (`createdBy: 'owner'`, summary `Applied a token suggestion: --name, …` listing only the validated token names so
    third-party author names and proposed values never enter `artifact_get` version metadata without an untrusted-input
    notice), then atomically sets `suggestion.appliedVersion = newVersion` and `status = 'resolved'` on the thread in
    `CommentStore`. If all tokens already equal `change.to`, marks `appliedVersion = currentVersion` and
    `status = 'resolved'` without creating an empty version. Returns `200 { version, design, comment }`.
- **Agents, Desktop details, and artifact transfer**:
  - `artifact_comments` (`apps/desktop/src/main/mcp/tools/artifact-comments.ts`): `EnvelopeThread` includes optional
    `suggestion` inside the `<`-escaped `<artifact-comments>` envelope after the untrusted-feedback notice, giving
    agents exact `file`, `from`, `to`, and `appliedVersion` fields for `artifact_update` + `artifact_comment_resolve`.
  - Desktop details (`apps/desktop/src/shared/artifacts.ts`, `CommentThreads.tsx`, `comments-view.ts`):
    `ArtifactCommentView` gains `suggestion: TokenSuggestion | null`; `CommentThreads.tsx` renders each `--name: from →
    to` row as plain text (`textContent`) plus an `"Applied in vN"` badge when `appliedVersion !== null`;
    `draftFromComments` (**Send to conversation**) appends the suggested token lines under the thread quote.
  - Transfer (`schemas.ts`, `admin.ts`, `transfer.ts`): `ArtifactExport['comments'][number]` and `importInput` include
    `suggestion: tokenSuggestionSchema.nullable().default(null)` (verifying `appliedVersion` exists in `versions` when
    non-null), and `sameContent` includes `comment.suggestion ?? null` in its canonical comparison tuple.

---

### 6. Compatibility and migration

- **Viewer ↔ Gateway**: `SHELL_FILES` and `BRIDGE_SCRIPT` are embedded into `@maestrly/artifact-host` at build time and
  served by the same gateway process that hosts `/a/:id/api/*`, so the viewer, bridge, routes, and SQLite schema
  (`SCHEMA_VERSION = 5`) always upgrade together.
- **New Desktop / MCP tools against an older Gateway**:
  - No new `ADMIN_METHODS` RPC calls are required by the desktop or agent tools (`listComments`, `update`, and
    `setCommentResolved` already exist).
  - Older gateways return `CommentView` without `suggestion`; desktop normalizes `comment.suggestion ?? null` and omits
    `suggestion` from `<artifact-comments>` when null.
  - `transferArtifact`: moving an artifact **without** suggestions to an older gateway succeeds (`undefined ?? null`
    matches `null` in `sameContent`). Moving an artifact **with** suggestions sees the older gateway strip `suggestion`
    on `importArtifact`, causing `sameContent(copy, manifest)` to fail with `verify_failed` *before* `source.delete(id)`
    so suggestions are never silently dropped (matching the `responses` transfer contract).
- **Older Desktop against a newer Gateway**:
  - `fromWire` and older `service.ts` pick known `CommentView` fields and ignore `suggestion`; non-empty `comment.body`
    preserves readable feedback in older UIs and agent transcripts.
  - Comments with suggestions emit the existing `'comment_added'` kind on `artifact.activity`, keeping the closed
    `fleetGatewayEventSchema` enum in `packages/bot-fleet-protocol/src/domain.ts` 100% compatible with older desktops
    and mobile clients.
- **Bot fleet feature detection**: `packages/bot-fleet-protocol/src/constants.ts` adds
  `FLEET_ARTIFACTS_DESIGN_FEATURE = 'artifacts-design'`, announced in `moreFeatures` in
  `apps/bot-gateway/src/routes/public.ts` (leaving `features` frozen at `FLEET_META_FEATURES_LEGACY_MAX = 20` so legacy
  desktops never reject `/v1/meta`).

---

### 7. Security analysis

| Surface / Threat | Mitigation |
| --- | --- |
| Malicious page spoofing or flooding `inspect-hover`, `inspect-pick`, `inventory`, or `layout` | `parseBridgeMessage` validates fixed shapes on null-safe plain objects (ignoring `__proto__`/`constructor`/`prototype`), enforces regexes on `component`, `props` keys, and `--*` token names, requires finite `SelectionRect`s and integer counts `0..10_000`, caps every string/array (`selector <= 300`, `styles.* <= 120`, `tokens <= 64`, `props <= 32`, `instances <= 200`), and throttles hover/scroll in `bridge.ts`. The shell writes every string via `textContent` (`dom.ts`), never `innerHTML`. |
| CSS injection or rule breakout in token preview / saved `tokens[0]` | Independent validation in host (`design.ts`), shell (`design-model.ts`), and frame (`bridge.ts`): names must match `^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`, theme selectors must match the closed theme allowlist, and values forbid `;`, `{`, `}`, `<`, `\`, `/*`, `*/`, `!important`, and control chars. Preview builds only `--name: value !important;` declarations inside `adoptedStyleSheets`; saving replaces only `[valueStart, valueEnd]` spans in `tokens[0]`. |
| Exfiltration via `url()`, `image-set()`, or `src()` in token values | Lexical check rejects `/\b(?:url|image-set|-webkit-image-set|src)\s*\(/i` (and `\` blocks CSS hex-escape bypasses like `\75 rl(`). Defense in depth: `contentHeaders` CSP restricts `img-src`/`style-src`/`font-src` to `/c/<cap>/` + the 5 fixed public CDNs and `connect-src` to `/c/<cap>/` only. |
| Malicious commenter submitting crafted suggestions | `POST comments` enforces `writer(ctx)` (`commentsEnabled`, session, named principal, rate limits, 2,000-comment cap), `.strict()` schema accepting only `{ changes }`, verifies every `(name, theme)` exists in `version`'s `tokens[0]`, and computes `file` and `from` on the server. Suggestions never auto-run; `artifact_comments` escapes `<` as `\u003c` under the untrusted-feedback notice. |
| CSRF or non-owner version creation on `POST tokens` / `POST comments/:id/apply` | `allowedOrigin` Host check, exact `Origin === origin`, `x-maestrly-artifact: 1`, `Content-Type: application/json`, `HttpOnly; SameSite=Strict` cookie scoped to `/a/<id>/api`, `ctx.access?.kind === 'owner'`, `baseVersion === currentVersion`, `tokenSave` rate limit (`20/min`), and `200`-version / quota caps. |
| DoS via large manifests, huge CSS, or 50 heavy Board frames | `maestrly-design.json <= 64 KiB`, `tokens[0] <= 256 KiB`, `<= 200` tokens, `<= 50` screens, `O(N)` non-regex CSS scanner, `MAX_SCANNED_RULES = 2000`, `MAX_INVENTORY_NODES = 5000`, `MAX_LIVE_SCREEN_FRAMES = 6` with `about:blank` teardown on eviction, and `MAX_CONCURRENT_FRAME_LOADS = 2`. |
| Leaking viewer/commenter identity into untrusted frames | Previewing a comment's suggestion sends only `{ name, value: change.to, theme }` into frames—never author names, comment IDs, comment bodies, or principal IDs. `GET design` exposes only the artifact's own files. |

---

### 8. Work split and Core ↔ UI TypeScript contract

#### Division of deliverables

- **Core PR (`feat/design-viewer-core`)**:
  - Host & storage: `packages/artifact-host/src/design.ts`, `store/db.ts` (`SCHEMA_VERSION = 5`), `store/comment-store.ts`,
    `comments.ts`, `schemas.ts`, `admin.ts`, `limits.ts`.
  - HTTP routes: `http/design-routes.ts` (`GET design`, `POST tokens`), `http/comment-routes.ts` (`suggestion` on
    `POST comments`, `POST comments/:id/apply`), `http/rate-limit.ts` (`tokenSave`), `http/server.ts` (`await` async
    handlers).
  - Bridge & contract: `shell/contract.ts` and `shell/bridge.ts`.
  - Headless shell core: `shell/design-model.ts` (pure functions, zero DOM) and `shell/design.ts` (`DesignController`:
    state, API calls, `FrameRegistry`, lazy screen iframe lifecycle, Inspect/Inventory/Preview coordination), plus
    minimal `FrameRegistry` hook in `shell/viewer.ts`.
  - Fleet & Desktop: `FLEET_ARTIFACTS_DESIGN_FEATURE` in `bot-fleet-protocol` + `bot-gateway`, `artifact_comments`
    envelope update, Desktop `ArtifactCommentView.suggestion` + `CommentThreads.tsx` + `comments-view.ts`, and tests.
- **UI PR (built on top of `contract.ts`, `design-model.ts`, and `design.ts`)**:
  - `shell/inspect.ts` (Inspect side panel and stage hover/selection overlay), `shell/screens.ts` (pannable/zoomable
    screens surface mounting `controller.screenFrame(id)`), `shell/tokens.ts` (grouped token editors, diff list, Save /
    Suggest actions), suggestion preview/apply controls in `shell/thread.ts` / `shell/comments.ts`, top-bar controls in
    `shell/bar.ts`, layout wiring in `shell/viewer.ts`, styles in `shell/viewer.css`, icons in `shell/icons.ts`, and
    `en`/`pt-BR` strings in `shell/i18n.ts` following `prototypes/artifact-design-viewer/`.

#### Concrete TypeScript interfaces (`shell/contract.ts`, `shell/design-model.ts`, `shell/design.ts`)

Remember that `scripts/embed-shell.mjs` compiles `src/shell/*.ts` directly to browser ES modules with **sibling
`./[a-z0-9-]+\.js` imports only** (no npm imports in `src/shell/`).

```ts
// --- packages/artifact-host/src/shell/contract.ts (additions) ---

export const MAX_DESIGN_TOKENS = 200
export const MAX_DESIGN_SCREENS = 50
export const MAX_DESIGN_COMPONENTS = 200
export const MAX_TOKEN_VALUE_CHARS = 200
export const MAX_INSPECT_TOKENS = 64
export const MAX_INSPECT_PROPS = 32

export type TokenGroup =
  | 'color'
  | 'font'
  | 'text'
  | 'space'
  | 'radius'
  | 'shadow'
  | 'duration'
  | 'ease'
  | 'other'

export type TokenValueKind = 'color' | 'length' | 'number' | 'text'

export type ScreenViewportPreset = 'desktop' | 'tablet' | 'mobile'
export type ScreenViewport = ScreenViewportPreset | { width: number; height: number }

export interface DesignScreen {
  id: string
  name: string
  path: string
  viewport: ScreenViewport
}

export interface DesignToken {
  name: string
  group: TokenGroup
  kind: TokenValueKind
  /** Base `:root` value. */
  value: string
  /** Optional theme selector -> override value (for example `'[data-theme="dark"]': '#0f172a'`). */
  themes: Record<string, string>
}

export interface ViewerDesign {
  title: string | null
  tokenFile: string
  allTokenFiles: string[]
  componentsPath: string | null
  screens: DesignScreen[]
  componentTokens: Record<string, string[]>
  tokens: DesignToken[]
  /** Ordered list of distinct theme selectors found in `tokenFile`. */
  themes: string[]
}

export interface TokenChange {
  name: string
  value: string
  /** Null or omitted for `:root`; a validated theme selector for a theme override. */
  theme?: string | null
}

export interface TokenSuggestionChange {
  name: string
  from: string
  to: string
  theme?: string
}

export interface TokenSuggestion {
  file: string
  changes: TokenSuggestionChange[]
  appliedVersion: number | null
}

// PublicComment gains: `suggestion: TokenSuggestion | null`

export interface ComputedStyleSubset {
  fontFamily: string
  fontSize: string
  fontWeight: string
  lineHeight: string
  color: string
  backgroundColor: string
  borderRadius: string
  padding: string
}

export interface UsedToken {
  name: string
  value: string
}

export interface InspectHover {
  selector: string
  rect: SelectionRect
  tag: string
  component: string | null
  main: boolean
}

export interface InspectTarget extends InspectHover {
  props: Record<string, string>
  styles: ComputedStyleSubset
  tokens: UsedToken[]
}

export function isValidTokenName(value: unknown): value is string
export function isValidTokenValue(value: unknown): value is string
export function isValidThemeSelector(value: unknown): value is string
export function isValidComponentName(value: unknown): value is string
```

```ts
// --- packages/artifact-host/src/shell/design-model.ts ---

import type {
  DesignScreen,
  DesignToken,
  ScreenViewport,
  ScreenViewportPreset,
  TokenChange,
  TokenGroup,
  TokenSuggestionChange,
  TokenValueKind,
  UsedToken,
  ViewerDesign,
  ViewerState,
} from './contract.js'

export const MAX_LIVE_SCREEN_FRAMES = 6
export const MAX_CONCURRENT_FRAME_LOADS = 2
export const VIEWPORT_PRESETS: Readonly<Record<ScreenViewportPreset, { width: number; height: number }>>

export function groupOfToken(name: string): TokenGroup
export function classifyTokenValue(name: string, value: string): TokenValueKind
export function groupTokens(tokens: readonly DesignToken[]): ReadonlyMap<TokenGroup, DesignToken[]>
export function resolveScreenViewport(viewport: ScreenViewport): { width: number; height: number }
export function screenFrameUrl(capabilityUrl: string, screenPath: string): string | null
export function tokenDraftKey(name: string, theme?: string | null): string
export function lookupDesignTokenValue(design: ViewerDesign | null, name: string, theme: string | null): string | null
export function mergeInspectedTokens(
  reported: readonly UsedToken[],
  component: string | null,
  design: ViewerDesign | null,
  draftChanges: readonly TokenChange[],
  activeTheme: string | null
): UsedToken[]
export function diffTokens(
  design: ViewerDesign | null,
  drafts: ReadonlyMap<string, TokenChange>
): { name: string; from: string; to: string; theme: string | null }[]
export function selectLiveScreens(options: {
  screens: readonly DesignScreen[]
  visibleIds: readonly string[]
  focusedId: string | null
  lruIds: readonly string[]
  limit?: number
}): string[]
export function canSaveTokens(state: ViewerState, version: number, design: ViewerDesign | null): boolean
export function canSuggestTokens(state: ViewerState, design: ViewerDesign | null): boolean
export function canApplySuggestion(state: ViewerState, design: ViewerDesign | null): boolean
export function formatTokenSummary(changes: readonly TokenSuggestionChange[], prefix?: string): string
export function formatAppliedSuggestionSummary(names: readonly string[]): string
```

```ts
// --- packages/artifact-host/src/shell/design.ts ---

import type { ArtifactApi } from './api.js'
import type {
  BridgeMessage,
  DesignToken,
  InspectHover,
  InspectTarget,
  PublicComment,
  SelectionRect,
  TokenChange,
  TokenSuggestionChange,
  ViewerDesign,
  ViewerState,
  ViewerVersion,
} from './contract.js'

export type DesignView = 'page' | 'screens'

export interface ScreenUsage {
  screenId: string
  screenName: string
  count: number | null
  measuring: boolean
}

export interface ScreenFrameState {
  screenId: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage: string | null
}

export interface DesignSnapshot {
  version: number
  loading: boolean
  /** Non-null when `version` has a valid `maestrly-design.json`. */
  design: ViewerDesign | null
  view: DesignView
  /** Path currently loaded in the main stage frame (for example `'index.html#/dashboard'` or `'components.html'`). */
  stagePath: string | null
  inspecting: boolean
  tokensOpen: boolean
  hovered: InspectHover | null
  inspected: InspectTarget | null
  /** Live box of `inspected` updated on frame scroll/resize, or null. */
  inspectedRect: SelectionRect | null
  /** Active theme edited in the Tokens panel (`null` = `:root`). */
  activeTheme: string | null
  /** Pending uncommitted token edits (`key` = `${theme ?? ''}\n${name}`). */
  draftChanges: readonly TokenChange[]
  /** Comment ID when the active preview comes from previewing a thread's suggestion, otherwise null. */
  previewingCommentId: string | null
  focusedScreenId: string | null
  screensState: ReadonlyMap<string, ScreenFrameState>
  /** Component name -> per-screen instance counts collected so far. */
  componentUsage: (component: string) => ScreenUsage[]
}

export type DesignWriteError =
  | 'forbidden'
  | 'comments_disabled'
  | 'name_required'
  | 'version_conflict'
  | 'version_replaced'
  | 'version_limit'
  | 'quota_exceeded'
  | 'no_design_contract'
  | 'already_applied'
  | 'suggestion_conflict'
  | 'invalid_tokens'
  | 'no_changes'
  | 'rate_limited'
  | 'failed'

export type SaveTokensResult =
  | { ok: true; version: ViewerVersion; design: ViewerDesign }
  | { ok: false; error: DesignWriteError; currentVersion?: number }

export type SuggestTokensResult =
  | { ok: true; comment: PublicComment }
  | { ok: false; error: DesignWriteError }

export type ApplySuggestionResult =
  | { ok: true; version: ViewerVersion; design: ViewerDesign; comment: PublicComment }
  | { ok: false; error: DesignWriteError; currentVersion?: number }

export interface DesignControllerOptions {
  api: ArtifactApi
  state: ViewerState
  stageFrame: HTMLIFrameElement
  version: number
  preview: boolean
  /** Called whenever `snapshot()` changes so UI panels re-render. */
  onChange(): void
  /** Mutual exclusion: called before enabling Inspect so Comment mode turns off. */
  onDisableCommenting(): void
  /** Called when `saveTokens` or `applySuggestion` creates a new current version. */
  onVersionCreated(version: ViewerVersion, design: ViewerDesign): void
  /** Called when a write fails with `version_replaced` for a viewer without history access. */
  onReplaced(): void
  /** Called when the guest sets their name during `suggestTokens`. */
  onIdentityChanged(): void
}

export interface DesignController {
  snapshot(): DesignSnapshot
  /** Records the latest `/c/<cap>/<entry>` returned by `POST frame` for `version` and loads `GET design`. */
  setVersion(version: number, frameUrl?: string, expiresAt?: number): Promise<void>
  /** Routes `window` `message` events: returns `'stage'`, `'screen'`, or `null` if from an unknown window. */
  routeMessage(source: MessageEventSource | null, message: BridgeMessage): 'stage' | 'screen' | null

  // View & Screens (`shell/screens.ts`)
  setView(view: DesignView): void
  /** Updates visible/focused screens in `screens` view and reconciles the `<= 6` live iframe pool. */
  setVisibleScreens(visibleIds: readonly string[], focusedId: string | null): void
  /** Returns the live `<iframe>` for `screenId` when pooled, or `null` when evicted/unmounted. */
  screenFrame(screenId: string): HTMLIFrameElement | null
  /** Focuses a screen in `screens` view without leaving it. */
  focusScreen(screenId: string | null): void
  /** Switches to `'page'` view and navigates `stageFrame` to `screen.path`. */
  openScreen(screenId: string): Promise<void>

  // Inspect & Components (`shell/inspect.ts`)
  setInspecting(on: boolean): void
  clearSelection(): void
  /** Navigates `stageFrame` to `manifest.components`, reveals `[data-ds="<name>"][data-ds-main]`, and gathers counts. */
  openMainComponent(component: string): Promise<boolean>
  /** Schedules background/live inventory collection for screens whose counts are still unknown. */
  requestInventory(): void

  // Tokens & Suggestions (`shell/tokens.ts`, `shell/thread.ts`)
  setTokensOpen(open: boolean): void
  setActiveTheme(theme: string | null): void
  /** Sets or updates one token override and broadcasts `token-preview` to `stageFrame` and all live screen frames. */
  setTokenValue(name: string, value: string, theme?: string | null): boolean
  resetToken(name: string, theme?: string | null): void
  discardTokens(): void
  /** Previews a comment's suggested changes across all live frames (`null` clears). */
  previewSuggestion(commentId: string | null, changes?: readonly TokenSuggestionChange[]): void
  saveTokens(): Promise<SaveTokensResult>
  suggestTokens(body: string, guestName?: string | null): Promise<SuggestTokensResult>
  applySuggestion(commentId: string): Promise<ApplySuggestionResult>

  /** Handles `Escape`: exits Inspect, closes selection, or closes Tokens panel as appropriate. */
  escape(): boolean
  destroy(): void
}

export function createDesignController(options: DesignControllerOptions): DesignController
```

---

### 9. Test plan

1. **Manifest, CSS scanner, and exact rewrites (`packages/artifact-host/test/design.test.ts`)**:
   - Valid `maestrly-design.json` with and without optional `title`, `components`, and `componentTokens`; rejection/null
     fallback on wrong `schema`, missing referenced HTML/CSS files, traversal paths (`../`), duplicate screen IDs,
     `> 50` screens, `> 8` token files, and `> 64 KiB` manifest.
   - `parseTokensCssWithSpans`: `:root` + `[data-theme="dark"]` + `.theme-light` + `@media (prefers-color-scheme: dark)`
     + `@layer`, block/inline `/* ... */` comments containing `--fake: red; }` and `{`, strings with `;`, nested
     `calc()`/`rgb()`/`cubic-bezier()`, `!important` preservation, duplicate declarations in the same scope (last wins),
     ignoring non-theme selectors, and capping at 200 tokens.
   - `classifyTokenValue` and `groupOfToken` across hex/rgb/oklch/color-mix/named colors, `px`/`rem`/`%`/`0`, unitless
     numbers, `150ms` (`'text'`), multi-value padding (`'text'`), and `var(--x)` (`'text'`).
   - Value security rejections: `;`, `{`, `}`, `<`, `\`, `/*`, `*/`, `!important`, newlines, `> 200` chars, `url(`,
     `URL (`, `image-set(`, `-webkit-image-set(`, and `src(`.
   - `buildTokenEdits`: byte-for-byte preservation of comments, formatting, and untouched tokens; disambiguation when
     `:root` and `.theme-light` share identical `--color-bg: #ffffff;` lines (`applyEdits` never throws
     `edit_ambiguous`); coalescing when `> 100` (`MAX_EDITS`) tokens change at once; deterministic `formatTokenSummary`
     truncation at `500` chars.
2. **Bridge contract and shell pure model (`packages/artifact-host/test/design-model.test.ts` and `test/shell.test.ts`)**:
   - `parseBridgeMessage` fuzz/boundary cases for `inspect-hover`, `inspect-pick`, `inventory`, `layout.inspectRect`,
     and `key: 'i'`: prototype-pollution keys (`__proto__`, `constructor`), oversized strings/arrays, invalid
     `data-ds` / `data-ds-props` / `--token` names, NaN/Infinity rects, negative inventory counts.
   - `selectLiveScreens` priority ordering (focused > visible center distance > LRU) within `MAX_LIVE_SCREEN_FRAMES = 6`,
     `screenFrameUrl` segment encoding with `?query` and `#fragment`, `mergeInspectedTokens`, and `diffTokens`.
   - `shell.test.ts` verifying `design.js` and `design-model.js` embed cleanly in `SHELL_FILES` with sibling-only
     imports and `BRIDGE_SCRIPT` remains a classic script with no `import`/`export`.
3. **HTTP routes, auth, CSRF, rate limits, and suggestions (`packages/artifact-host/test/http-design.test.ts`)**:
   - `GET /a/:id/api/design`: returns `{ design }` for valid contract, `{ design: null }` for plain pages and
     whiteboards, enforces `x-maestrly-artifact: 1`, session access, and `seesHistory` on older versions.
   - `POST /a/:id/api/tokens`: owner creates `v2` (`createdBy: 'owner'`) modifying only `tokens[0]`; `403` for
     invited/approved/guest and missing `Origin` or `x-maestrly-artifact`; `409` on `version_conflict`,
     `no_design_contract`, `version_limit`, and `quota_exceeded`; `429` after exceeding `tokenSave` rate limit.
   - Suggestions lifecycle: invited/guest (with name) creates comment with `suggestion` while `commentsEnabled` is on;
     refused (`403 comments_disabled`) when off, on replies (`parentId`), or with forged/unknown tokens; server
     populates `file` and `from` from `tokens[0]`; owner `POST /a/:id/api/comments/:id/apply` creates version, sets
     `appliedVersion`, and resolves thread; works across non-conflicting intermediate versions and returns `409` on
     `already_applied` or `suggestion_conflict`; `403` for non-owners.
4. **SQLite migration and transfer (`test/schema-migration.test.ts` and `test/transfer.test.ts`)**:
   - Migrating v1/v2/v3/v4 databases to `SCHEMA_VERSION = 5` preserves existing comments with `suggestion: null` and
     stores new suggestions cleanly.
   - Round-trip `exportArtifact` → `importArtifact` preserves `suggestion` (`file`, `changes`, `appliedVersion`) and
     satisfies `sameContent`; stripping `suggestion` (simulating an older target server) makes `sameContent` return
     `false` while suggestion-free artifacts compare `true`.
5. **Gateway, MCP tools, and Desktop (`packages/bot-fleet-protocol`, `apps/bot-gateway`, `apps/desktop`)**:
   - `FLEET_ARTIFACTS_DESIGN_FEATURE` in `/v1/meta` `moreFeatures` while `features.length` stays `<= 20`.
   - `commentsEnvelope` in `artifact-comments.test.ts` serializing `suggestion` with `<` escaped as `\u003c` and
     handling legacy gateways where `comment.suggestion` is `undefined`.
   - `comments-view.test.ts` / `CommentThreads` rendering plain-text token diffs, `"Applied in vN"` state, and
     `draftFromComments` diff lines.
