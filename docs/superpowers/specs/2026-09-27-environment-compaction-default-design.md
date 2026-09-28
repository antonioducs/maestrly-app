# Environment default compaction model

## Goal

A new bot in an existing environment should work without choosing a compaction model. Accounts belong to the
environment, so a compaction model chosen for the environment is valid for every bot in it.

## Decisions

| Topic | Decision |
| --- | --- |
| Semantics | Inherited. A bot without its own compaction model uses its environment's default. Changing the default changes every bot that inherits it. A bot can choose its own model and later go back to the default. |
| First default | Automatic. The schema 7 migration seeds each environment from the bot that already had a model. In an environment without a default, the first compaction model chosen for any of its bots becomes the environment default, and that bot inherits it. |
| No default | Unchanged: a bot with neither its own model nor an environment default stays in setup and starts no turn. |
| Conversation model | Out of scope. It already falls back to the environment's own default model. |

## Protocol (version 1, additive)

- Feature `environment-compaction` in `/v1/meta`. The same string in an instance's capabilities means it serves the
  environment model list below.
- `FleetEnvironment.compaction`: the default, nullable, default `null`.
- `FleetBot.compaction` becomes the effective model (its own, else the environment default), so Macs that predate
  this feature still show the model the bot compacts with.
- `FleetBot.compactionSource`: `'bot' | 'environment' | null`, default `null`. Null means no model is configured, or
  the gateway predates the feature; a Mac then treats a non-null `compaction` as the bot's own.
- `PATCH /v1/environments/:eid` accepts `compaction` (a config, or `null` to remove the default).
- `PATCH /v1/bots/:id` with `compaction: null` now means "inherit the environment default" (before: no model).
- New routes returning `fleetSelectionsResponseSchema` with `current: null`:
  - gateway `GET /v1/environments/:eid/selections`;
  - instance `GET /v1/environment/selections`, the environment's account model options (the same list every bot's
    `selections` returns).

## Gateway

- **Schema 7.** `environments.compaction_json TEXT`. Migration 6 → 7 (and 5 → 6 → 7), in the existing transaction
  with its integrity and foreign-key checks; schemas newer than 7 are refused.
  - Seed: the compaction of the environment's migrated bot (the bot whose id is the environment's id), else of its
    earliest-created bot that has one, active bots before archived ones.
  - Bots whose own model equals the seed (compared as parsed JSON) have their own model cleared, so they inherit it.
    Bots with another model keep it.
- **Stored vs viewed.** The store keeps each bot's own model. Only the bot view (`assemble`) and the profile sent to
  the instance resolve the effective model; a view is never written back to the store.
- **Bot patch.** A non-null model for a bot whose environment has no default becomes the environment default, and
  the bot keeps no model of its own; `environment.updated` is emitted and the other inheriting bots of the
  environment get it as in an environment patch. Otherwise the value (or `null`) is the bot's own. The effective
  model is pushed to the patched bot, if running, before anything is stored, as today.
- **Environment patch.** The default is stored first. Every active bot that inherits it gets `bot.updated`; in a
  running environment each of them is reinstalled with its new effective model under the environment's lock. A bot
  whose reinstall fails is left to a scheduled reconcile, which installs the stored configuration. A stopped
  environment's bots get it when it starts. Bots with their own model are not touched.
- **Model list.** The gateway route proxies the instance route. An environment that is not running answers
  `BOT_NOT_RUNNING`; an instance without the capability answers `CONFLICT` "Restart this environment to update it
  before choosing its compaction model."
- Instances need no other change: the profile already carries the effective model.

## Mac

- Shown only with the gateway feature; otherwise the current bot-only compaction settings stay.
- **Environment view.** A "Default compaction model" section: model, reasoning, Fast mode and interval, reusing the
  bot settings fields (extracted into a shared component), the bots that use it, and Save. It reads the model list
  from the new route; without the instance capability it shows the restart hint, and while the environment is
  stopped it shows the current default read-only.
- **Bot settings.** The model picker starts with "Environment default · {model}" (or "not set"). Choosing it saves
  `null`. While a bot inherits, its reasoning, Fast mode and interval fields are hidden and a link opens the
  environment's default. When the environment has no default, choosing a model shows "This also becomes the default
  of {environment}; its other bots will use it."
- The composer's setup banner is unchanged.
- The new refusal is localized; en and pt-BR strings.

## Compatibility

- Older Macs see the effective model and can still set a bot's own model; setting one in an environment without a
  default makes it the default, as for new Macs.
- A schema 6 gateway binary refuses a schema 7 database: downgrade by restoring a backup.
- Environments on images without the capability still inherit (the gateway sends the effective model); only the
  environment view's model list asks for a restart.

## Testing

- Protocol: defaults of the new fields, the patch refinement, route uniqueness.
- Gateway: migration seeding (migrated bot, shared environment with different models, no model, archived bots),
  5 → 7, refusal of 8; effective model in views and profiles; auto-adoption; propagation only to inheriting bots,
  including a stopped environment and a failed reinstall; `null` means inherit; the model list route and its refusals.
- Desktop: the instance route and capability; renderer helpers; IPC validation; Playwright for the environment
  section and an inheriting bot with no setup banner.
- Container E2E: Scout's first model becomes its environment's default; Partner joins already configured through
  inheritance, then chooses its own; a changed default reaches an inheriting bot and not one with its own model.
- The dev helper's `down` reads schema 7 records.
