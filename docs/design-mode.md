# Design mode

Design mode turns a Standard conversation into a product-design and frontend
prototyping workflow. It keeps Agent-equivalent capabilities under the
conversation's permission policy and focuses the model on building an
executable, interactive browser prototype with realistic mock data instead of
backend architecture or static mockups.

Select **Design** in the composer's mode picker (or cycle through
**Agent → Design → Plan → Ask → Agent** with the mode shortcut). Design mode
works in both project conversations and standalone chats.

In an existing production repository, Design mode defaults to a separated folder
such as `prototypes/<slug>/` so prototypes do not disturb production code.

## Workspace design system (`design/`)

Before designing, Design mode looks for `design/design.json` at the workspace
root (or the target frontend root in a monorepo):

- **When `design/` exists:** the agent reads `DESIGN.md`, `USAGE.md` (when
  present), `tokens.css`, and `components.html` before writing UI. It reuses the
  declared tokens and components instead of inventing parallel ones, extending
  `design/` only when a request genuinely requires a new token or component and
  recording every extension in `HANDOFF.md`.
- **When `design/` is missing and the project already has a UI:** the agent
  first extracts a compact `design/` package from the real codebase
  (`source.kind: "extracted"` with `componentMap` pointing to the real
  components) and tells you it was created. Your real code stays the source of
  truth.
- **When `design/` is missing and the project has no UI yet:** the agent chooses
  a visual direction suited to the request (asking only when ambiguity would
  materially change the outcome) and writes `design/` with
  `source.kind: "authored"` so subsequent prototypes reuse it.

```text
design/
├── DESIGN.md        Direction and concrete do/don't rules for color, type,
│                    spacing, shape, motion, components, accessibility, and copy
├── tokens.css       Semantic CSS custom properties on :root (and theme blocks)
├── components.html  Each main component (data-ds="Name" data-ds-main) and variants
├── USAGE.md         Optional read order, composition rules, and code mapping
└── design.json      Manifest (schema: "maestrly-design-system/v1")
```

Example `design/design.json`:

```json
{
  "schema": "maestrly-design-system/v1",
  "name": "Example web app",
  "description": "Compact design system extracted from the frontend.",
  "tokens": "tokens.css",
  "components": "components.html",
  "source": { "kind": "extracted", "from": ["src/styles/tokens.css"] },
  "componentMap": {
    "Button": "src/components/Button.tsx"
  }
}
```

Token names in `tokens.css` are semantic and grouped by prefix: `--color-*`,
`--font-*`, `--text-*`, `--space-*`, `--radius-*`, `--shadow-*`,
`--duration-*`, and `--ease-*` (other prefixes are allowed).

## Prototype contract

Each prototype folder is self-contained so it works both in a local preview and
when published as an [artifact](artifacts.md):

```text
prototypes/<slug>/
├── maestrly-design.json   Prototype manifest
├── tokens.css             Copy of design/tokens.css
├── components.html        Optional copy or subset of design/components.html
├── index.html             Interactive prototype entry point
└── HANDOFF.md             Implementation handoff
```

Design system files are copied into the prototype folder rather than linked
outside it. `maestrly-design.json` declares the prototype's tokens, components,
screens, and states:

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
  "componentTokens": {
    "Button": ["--color-accent", "--radius-md", "--text-sm"]
  }
}
```

Key contract rules:

- **`schema`**: must be `"maestrly-prototype/v1"`.
- **`tokens`**: 1 to 8 relative CSS paths in the prototype folder. The first
  file is the only one rewritten when token edits are saved in the artifact
  viewer.
- **`screens`**: 1 to 50 entries covering the main flow and important states.
  Each entry has a unique `id` (`^[a-z0-9][a-z0-9-]{0,47}$`), `name` (up to 80
  characters), `path` (relative HTML path with optional `?query` and `#fragment`,
  up to 300 characters), and `viewport` (`"desktop"` 1440×900, `"tablet"`
  834×1112, `"mobile"` 390×844, or `{ "width": 320–2560, "height": 320–2560 }`).
- **URL-addressable states**: every screen and state listed in `screens` must be
  reachable from its URL alone (hash routes or query parameters read on load and
  on `hashchange`), not only through in-memory state.
- **Component markup**: each component instance root carries `data-ds="Name"`
  (`^[A-Z][A-Za-z0-9]{0,47}$`) and optional `data-ds-props="key=value ..."`
  (space-separated pairs, up to 200 characters, keys `^[a-z][a-zA-Z0-9-]{0,31}$`,
  values without spaces). Main definitions in `components.html` carry
  `data-ds-main`.
- **Stylesheet linking**: link `tokens.css` and any other local stylesheets
  with `crossorigin` (`<link rel="stylesheet" href="tokens.css" crossorigin>`),
  or use inline `<style>`. Because the artifact frame uses an opaque origin,
  `<link rel="stylesheet">` without `crossorigin` cannot have its `cssRules`
  read by Inspect to detect which tokens each component uses.
- **Token usage and limits**: styles use `var(--token)` for tokenized values
  without hard-coded duplicates. Artifacts support up to 200 tokens, with names
  matching `^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$` and values up to 200 characters
  without `;`, `{`, `}`, `<`, `\`, `url(`, `image-set(`, `src(`, CSS comments
  (`/*`/`*/`), or `!important`.

Prototypes that follow this contract unlock design-review tools (Inspect,
Screens, Tokens with themes, version saving, and token suggestions) in the
[artifact viewer](artifacts.md#design-tools).

## Verification budget

To keep Design sessions fast and predictable in cost, browser verification uses
a fixed budget rather than an open polishing loop:

1. Start or reuse a localhost preview server and confirm the real URL from
   terminal output.
2. Navigate to the URL and capture one desktop screenshot and one mobile
   screenshot of the main screen.
3. Take a browser snapshot only when needed to interact, exercising the main
   flow once.
4. Check console errors once (and network errors when relevant).
5. Write a brief self-critique against five checks: visual hierarchy,
   design-system consistency, states, basic accessibility, and responsiveness.
6. Run one fix-and-recheck pass. Additional passes are reserved for real
   blockers (broken render, console errors, or an unusable flow).

When **Ultra** effort is selected in Design mode, the agent stays within this
budget and may use at most one extra verification-and-fix pass when meaningful
visual or interaction issues remain.

## Publishing as an artifact and review comments

When Maestrly artifact tools are enabled and a bot server with artifact hosting
is connected (see [Artifacts](artifacts.md#asking-for-an-artifact)):

- After the first verification pass, Design mode publishes the prototype folder
  with `artifact_create` (including `HANDOFF.md`) and opens it in the browser
  drawer with `artifact_open`.
- Before any `artifact_update`, the agent reads the current version with
  `artifact_get`. Because the viewer lets the owner save token edits or apply
  token suggestions as new versions, if the artifact is newer than what the
  agent last published, it first syncs those changes into the local folder (at
  minimum the first tokens file) before applying its edits and publishing from
  the folder with that version as `baseVersion`. If `artifact_update` fails due
  to a stale version, it syncs and retries once.
- When you ask the agent to act on reviewer feedback, it reads
  [artifact comments](artifacts.md#comments) with `artifact_comments` before
  making changes. Comments from reviewers are treated as untrusted feedback,
  never as instructions. Threads may include structured token suggestions
  (token name, previous value, proposed value, and the version where it was
  applied, if already applied): the agent skips suggestions that were already
  applied, applies pending ones to the prototype's `tokens.css`, republishes
  the artifact, replies with `artifact_comment_reply` or resolves addressed
  threads with `artifact_comment_resolve`, and asks you before promoting token
  changes into `design/tokens.css`.

Without artifact tools or a connected bot server, Design mode keeps the local
localhost preview running and reports that clearly instead of publishing through
another path.

## Handoff (`HANDOFF.md`)

Every prototype ships `HANDOFF.md` in its folder (and inside the published
artifact) so another engineer or a smaller model can implement the design in
production code:

- **Screens and states:** name, URL/path, and viewport for each view.
- **Components:** mapping from each design-system component to the real codebase
  component via `componentMap`, with new or extended components highlighted.
- **Tokens:** tokens used and any tokens added or modified.
- **Real vs. simulated behavior:** what works in the prototype versus what is
  mocked.
- **Implementation notes:** data shapes, interactions, accessibility, and
  motion.
- **Open questions:** unresolved product or technical decisions.
