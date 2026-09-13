# Harness profiles

A harness profile is everything Maestrly specializes for one model: prompt text, reasoning policy,
capability claims, runtime preferences, progress mode and hooks. Each profile is a folder with a
`config.json` and the Markdown it references. The build discovers the folders automatically, so you
never edit a runner, the service, the interface, the persistence layer or a manual registry to add a
model that reuses existing strategies.

Code lives in `apps/desktop/src/main/chat/harness/`:

| Module | Responsibility |
| --- | --- |
| `types.ts`, `schema.ts` | Versioned definition and its strict Zod schema |
| `registry.ts` | Parses, validates and freezes the file sources; exact identity lookup |
| `catalog.ts` | Bundler glob over `profiles/*/config.json` and `profiles/*/*.md` |
| `resolver.ts`, `policies.ts` | Selects a profile, merges bindings, intersects capabilities and efforts |
| `prompt-builder.ts`, `host-contracts.ts`, `strategies/` | Prompt layouts, host contracts, reusable algorithms |
| `adapters/` | Translate transport facts into policy (Responses, Codex, Claude, Copilot, generic) |
| `compatibility.ts` | Snapshots and contract hashes for persisted sessions |
| `execution.ts`, `flags.ts` | Per-execution contract and flags captured once at admission |

Shared, serializable types used by the renderer live in `apps/desktop/src/shared/harness.ts`.

## Folder layout

```text
profiles/
  default/            mandatory; complete base policy
    config.json
    style.md
  <model-id>/         folder name = primary model identity
    config.json       mandatory in every folder
    *.md              only the texts the config references
```

The folder name is the model id matched against the canonical id confirmed by the transport, or the
requested id when the transport confirms none. Matching is exact after trimming: no substring, family,
prefix stripping or nearby-version inference. `match.aliases` adds more exact ids and
`match.caseInsensitive` normalizes case, only where the model already relied on it.

A model without a folder, or whose folder has no binding for the current transport, runs on the default
profile. An invalid folder fails validation; it is never a silent fallback.

## Configuration

```jsonc
{
  "schemaVersion": 1,            // literal; other versions are rejected
  "id": "acme-orbit-2",          // stable identity, unique across the catalog
  "profileVersion": 1,           // positive integer
  "match": { "aliases": [], "caseInsensitive": false },
  "featureFlag": { "key": "chat.acmeOrbit2Profile", "default": true },
  "bindings": [ { "providerKind": "*", "endpoint": "any", "overrides": {} } ],
  "source": { "repository": "…", "commit": "…", "path": "…", "license": "…" }
}
```

Unknown fields are rejected everywhere. Text references are plain `.md` file names inside the same
folder — no paths, `..`, absolute paths or URLs. Inheritance from the default happens at resolution,
never through a path.

### Bindings

`providerKind` is a `ChatProviderKind` or `*`; `endpoint` is `any` (default) or `official-openai`
(only valid with `openai-responses`). Two bindings with the same pair are invalid.

Bindings merge in this order, later wins:

1. default `*/any`, 2. default transport binding, 3. default endpoint binding,
4. profile `*/any`, 5. profile transport binding, 6. profile endpoint binding.

Known objects merge field by field, arrays replace, explicit `false` is kept, omitted fields inherit,
and `null` only disables a reference or option that accepts it. There is no `extends` between models.

### Overrides

| Field | Meaning |
| --- | --- |
| `identity.harnessProfileId` | Versioned identity persisted by the OpenAI transports |
| `identity.behaviorProfileId` | Behavioral identity frozen in review loops and session handles |
| `identity.compatibilityGroup` | Group used by the compatibility snapshot |
| `identity.promptIdentity` | Prompt template identity, independent from transport |
| `prompts.layout` | `maestrly-base`, `openai-codex-port` or `openai-astra` |
| `prompts.base` | Base instructions for the `openai-*` layouts |
| `prompts.styleAndWork` | Style and work body of the Maestrly layout |
| `prompts.behaviorHeader` | Emit the execution-scoped behavioral header |
| `prompts.subagent`, `prompts.compaction` | Texts appended to subagent and compaction prompts |
| `prompts.ultra` | `{ base, byMode: { agent, ask, plan, design, maestro } }` |
| `prompts.developerPrefix` | `{ base, asyncTools? }` for transports with separate developer instructions |
| `prompts.environment` | `placement` (`system`, `last-user-message`) and `transient` |
| `reasoning.manifestEfforts` | Efforts the profile allows; `null` keeps the runtime catalog authoritative |
| `reasoning.nonSerializableEfforts` | Tiers never sent to the provider |
| `reasoning.nativeUltra` | Provider has a native maximum tier; skip the synthetic Ultra overlay |
| `capabilities.*` | Boolean model claims (see `HarnessCapabilities`) |
| `runtime.*` | `promptCacheTtl`, `personality`, `nativeCompactionFirst`, `experimentalContext`, `codexPromptVersion` |
| `progress` | `default`, `summarized` or `prompt-only` |
| `hooks` | `[{ id: "post-tool-read-guidance", text, maxReminders? }]` |

`off` and `default` are interface resets; they clear the override and are never sent as an effort.

### Capabilities versus transports

A capability is enabled only when the profile claims it, the runtime does not deny it and the
transport adapter implements it. An explicit `false` from the runtime or the adapter always wins. A
configuration can restrict a transport but never enables a protocol that has no implementation — for
example, BYOK Responses streams over HTTP/SSE, so steering and live reasoning stay off there whatever
a profile claims.

Host contracts are composed outside profile text and cannot be removed by configuration: mode
restrictions (Ask, Plan, Design, Maestro), the actual toolset, permissions, memory and project
guidance, Maestro policy and account identity.

## Flags

`featureFlag` is read once per execution at admission (`flags.ts`), for every profile in the catalog.
A later toggle never changes a running turn, and a frozen review-loop execution keeps its recorded
profile regardless of the live flag.

## Versioning and compatibility

Each native binding stores a `HarnessSnapshotV1`: profile id and version, the applied contract, the
compatibility group and a canonical hash of the effective definition (policies, strategies and
referenced texts). Changing a prompt invalidates saved sessions even if `profileVersion` is not bumped;
CRLF/LF and a trailing newline do not. Volatile data (date, environment, user text) is never hashed.

Rows written before snapshots existed have a `NULL` snapshot and keep their previous transport
checks. Any non-NULL snapshot that is corrupt or different blocks resume, and a frozen execution
whose contract cannot be reproduced fails explicitly instead of switching profile.

## Adding a model

When the model only needs existing strategies, create the folder and nothing else. This example is
validated by `apps/desktop/test/unit/chat-harness-extension.test.ts`.

`profiles/acme-orbit-2/config.json`:

<!-- example:config -->
```json
{
  "schemaVersion": 1,
  "id": "acme-orbit-2",
  "profileVersion": 1,
  "featureFlag": { "key": "chat.acmeOrbit2Profile", "default": true },
  "bindings": [
    {
      "providerKind": "*",
      "overrides": {
        "identity": { "behaviorProfileId": "acme-orbit-2-v1" },
        "prompts": { "styleAndWork": "prompt.md", "behaviorHeader": true },
        "hooks": [{ "id": "post-tool-read-guidance", "text": "read-batching.md", "maxReminders": 12 }]
      }
    },
    {
      "providerKind": "codex-subscription",
      "overrides": {
        "identity": { "harnessProfileId": "acme-orbit-2-v1", "compatibilityGroup": "acme-orbit-2-v1" },
        "reasoning": { "manifestEfforts": ["low", "medium", "high"], "nonSerializableEfforts": ["minimal"] },
        "capabilities": { "compaction": true, "steering": true, "parallelTools": true },
        "runtime": { "nativeCompactionFirst": true }
      }
    }
  ]
}
```

`profiles/acme-orbit-2/prompt.md`:

<!-- example:prompt -->
```markdown
# Style
Lead with the result in the user's language. Keep progress notes short.

# Working on the project
Orbit works in small, verified steps. Read before editing and report checks faithfully.
```

`profiles/acme-orbit-2/read-batching.md`:

<!-- example:hook -->
```markdown
Group further independent reads in parallel before continuing.
```

Add a TypeScript strategy only when the model needs a new algorithm or protocol: a new prompt layout,
hook or environment placement goes in `strategies/`, gets its id in `types.ts` and schema, and gets its
own tests. Profiles then reference it by id.

## Verifying

- `npm run test:unit --workspace @maestrly/desktop -- test/unit/chat-harness-` runs the harness suites.
- `npm run build:desktop` validates the catalog before bundling; an invalid profile names the folder,
  file and field. Profile texts are inlined into the main bundle, so the packaged app never reads `src/`.
- In `npm run dev`, profile files are watched by the main build: adding or editing one rebuilds the main
  process. Changes apply to new executions only; there is no hot reload inside a running turn, and no
  loading of profiles from outside the repository.
