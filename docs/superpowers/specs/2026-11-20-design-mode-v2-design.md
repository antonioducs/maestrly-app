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
| `tokens` | 1 to 8 relative paths of CSS files in the artifact. The first one is where token edits are saved. |
| `components` | Optional relative path of the components page. |
| `screens` | 1 to 50 entries. `id` matches `^[a-z0-9][a-z0-9-]{0,47}$` and is unique; `name` is at most 80 characters; `path` is a relative path of an HTML file in the artifact, optionally followed by `?query` and `#fragment`, at most 300 characters; `viewport` is `desktop` (1440×900), `tablet` (834×1112), `mobile` (390×844) or `{ "width": 320–2560, "height": 320–2560 }`. |
| `componentTokens` | Optional. Component name to the tokens it uses, as a hint for Inspect when stylesheets cannot be read. |

Markup:

- `data-ds="Button"` marks the root element of a component instance. Names match `^[A-Z][A-Za-z0-9]{0,47}$`.
- `data-ds-props="variant=primary size=md"`: space-separated `key=value` pairs, at most 200 characters, keys matching
  `^[a-z][a-zA-Z0-9-]{0,31}$` and values without spaces.
- `data-ds-main` marks the main component definition, in `components.html`.
- Every screen and every state named in `screens` is reachable by its URL alone: hash routes or query parameters that
  the prototype reads on load and on `hashchange`. Primary flows never depend on state that exists only in memory.
- Styles use `var(--token)` for every design value that the tokens file defines; no hard-coded duplicates.

Limits shared by the host, bridge and viewer: 200 tokens per artifact, token names matching
`^--[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$`, token values at most 200 characters without `;`, `{`, `}`, `<`, `\`, or `url(`.

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

To be completed by the core implementation: protocol messages, how the bridge applies previews, how the host parses
the manifest and the tokens file and rewrites declarations, the save and suggestion endpoints and storage, agent tool
changes, and compatibility with older gateways and desktops.
