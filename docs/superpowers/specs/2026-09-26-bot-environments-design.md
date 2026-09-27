# Bot environments — design

Date: 2026-09-26. Branch: `feat/maestrly-bot-experimental`.

## Goal

Let the owner group fleet bots into **environments**. An environment is one container: one Maestrly process, one home
folder, one set of accounts, skills, MCP servers and site logins. Several bots run inside it and share all of that.

When creating a bot, the owner chooses:

- **New environment (isolated):** the bot gets its own container, as today;
- **An existing environment (shared):** the bot joins a container that is already configured and signed in, with no
  new container and no new sign-ins.

The owner's use case: one environment for company X, one for company Y and one for personal work, each with several
bots. The isolation boundary is the environment, not the bot.

Today every bot is its own container: about 0.5 GB of memory each, plus accounts, skills and MCP servers to set up for
every new bot.

## Decisions

| Topic | Decision |
| --- | --- |
| Name | "Environment" (pt-BR "Ambiente"). |
| Trust boundary | The environment. Bots of one environment run as the same Linux user and can reach each other's files, processes and screens. The ceiling still limits each bot's tools, and "talks to" still limits messages through the gateway, but neither is a sandbox inside an environment. |
| Shared per environment | Accounts (API keys and subscriptions), skills, MCP servers, site logins (browser cookies), the home folder, installed tools, the environment screen (Maestrly settings), memory limit, lifecycle (start, stop, restart, update). |
| Per bot | Name, role, instructions, tint, ceiling, talks-to, model selection, compaction, conversation, queue, pause, takeover, bot memory, routines, inbox items, **its own browser area** and **its own apps screen**. |
| Screens | Each bot has two areas: **Browser** (its browser window, driven by `browser_*`) and **Apps** (its own Linux display, driven by `computer_*` and by the programs it launches). The Mac shows a `Browser | Apps` switch. This applies to isolated bots too. |
| Owner memory | Global plus per environment. Entries the owner writes are global by default. Entries a bot saves belong to its environment. The owner can make an environment entry global. Existing entries stay global. |
| Existing bots | Each becomes an environment with one bot, keeping its container, home volume, conversation and data. |
| Limits | At most 8 bots per environment. The environment memory limit defaults to the gateway's (4 GB) and can be changed per environment. |
| Out of scope | Moving a bot between environments; per-bot memory and CPU figures; separate site logins per bot inside an environment; separate Linux users per bot; GUI programs for Copilot and Cursor runtimes (their runtimes have no `DISPLAY` today either). |

## Measurements (2026-09-26, dev image `0.9.3`)

- **Current cost per bot.** A running idle bot container uses 421–507 MiB: Electron about 450–500 MiB, the screen
  stack (Xvfb, x11vnc ×2, openbox, tint2) about 70 MiB, Codex about 30 MiB.
- **Browsers in one process.** One Electron process with 2 bot browser windows on one display used 240 MiB PSS; with
  6 windows, 299 MiB (about 15 MiB per extra idle window; loaded pages add renderer memory as usual).
- **Concurrent browser input.** Two bots sending CDP clicks and text into their own windows of one process at the same
  time: both pages visible and focused, 3 clicks and the right text each.
- **Separate displays.** Two Xvfb displays keep independent pointers and keyboards (`xdotool` on `:1` and `:2` did not
  interfere). An Xvfb display at 1280×800 costs about 37–42 MiB PSS; one at 3840×2400 about 73 MiB.
- **Clipped VNC.** `x11vnc -clip 1280x800+X+Y` serves a 1280×800 framebuffer of one area of a bigger display and maps
  the owner's clicks into that area.
- **Single-instance programs.** Chromium launched from display `:2` opened its window on `:1` when both used the
  default profile. With one profile folder per bot, each window opened on the right display, also through
  `xdg-open`.
- **Estimated cost of an extra bot in a shared environment:** 80–150 MiB idle (apps display, window manager, browser
  window, conversation state), against about 500 MiB for a new container. Under load, open pages and the programs a
  bot runs cost the same in both models.
- **Estimated cost of an isolated environment:** about 80 MiB more than today's bot, because the environment display
  is bigger (3840×2400) and the bot's apps now have their own display.

## Screens

One Electron process can only draw windows on one X display. Site logins must be shared, so every bot's browser lives
in that one process, and therefore on one display.

- **Environment display `:0`.** Xvfb at 3840×2400, split into a 3×3 grid of 1280×800 tiles:
  - tile 0 holds the **environment screen**, the Maestrly settings window, used for account sign-in on the screen;
  - tile *k* (1–8) holds the browser window of the bot in slot *k*, pinned and filling its tile;
  - popups and dialogs of a bot's browser (for example a "Sign in with Google" window) open inside its tile.

  openbox manages `:0` (focus and placement); it has no taskbar.
- **Apps display `:k` per bot.** Xvfb 1280×800, openbox, tint2 and its own D-Bus session bus, so single-instance
  programs open on the right display. The bot's shells, `computer_*` tools and the programs it launches use it.
  - `BROWSER` points to a per-bot wrapper that runs Chromium with the profile `~/.config/maestrly-bots/<botId>/chromium`
    and `--password-store=basic` (the keyring lives on the environment's bus, not the bot's).
- **Display manager.** It lives in the Maestrly main process and starts, supervises and stops each bot's apps stack.
  A crashed stack restarts after a short delay; archiving a bot stops its stack.
- **VNC.** It starts on demand when a view or control tunnel opens and stops 60 s after the last client leaves:
  - the browser area is `x11vnc -display :0 -clip <tile>`;
  - the apps area is `x11vnc -display :k`;
  - the environment screen is the clip of tile 0.

  The always-on x11vnc pair goes away.
- **Owner input on `:0`.** The browser areas and the environment screen share `:0`'s pointer and keyboard focus, so
  at most one control session on `:0` runs per environment at a time; a second one gets `CONFLICT`. Apps areas are
  independent.
- **Tools.**
  - `browser_*`: unchanged (CDP into the bot's own tabs).
  - `computer_*`: act on the bot's apps display. `xdotool` runs with `DISPLAY=:k`; screenshots come from an X capture
    of `:k` instead of Electron's `desktopCapturer`, which only sees `:0`. Cancelling screen actions is per bot.
- **Per-bot shell environment.** `DISPLAY=:k`, the bot's `DBUS_SESSION_BUS_ADDRESS` and its `BROWSER` are injected into:
  - the built-in `bash` tool and PTY terminals;
  - Codex, through the per-thread `shell_environment_policy.set`;
  - Claude, merged over the manager's allowlisted environment per query.

  MCP `stdio` servers are environment-wide and get no bot display. Copilot and Cursor runtimes keep having no display,
  as today.
- **Identity prompt.** It tells the bot:
  - it has its own browser (`browser_*`) and its own apps screen (`computer_*`);
  - which other bots share its environment;
  - that files, accounts, skills, MCP servers and site logins are shared with them.

## Bot instance (the app in the container)

- **`EnvironmentRuntime`** (one per process) owns:
  - the control server and the environment configuration (control token, gateway URL);
  - the display manager, the environment screen;
  - provisioning (accounts, skills, MCP servers, remote sign-ins);
  - a registry `botId → BotRuntime`.
- **`BotRuntime`** (today's `BotInstanceRuntime`, keyed by bot) keeps everything per bot:
  - storage in `fleet-instance/bots/<botId>/{inputs,transcript}.json` and images in `fleet-images/<botId>/`;
  - the settings `fleet.instance.bots.<botId>.profile|paused` and the memory space `bot-self:<botId>`;
  - its hold gate, help requests, gateway client (with its own gateway token), owner-memory client, compaction
    settings and screen-action cancellation.
- **Lookup by conversation.** Everything that runs inside a conversation (app tools, identity prompt, hold gate, memory
  hooks, compaction) resolves `conversationId → BotRuntime` instead of reading a process singleton.
- **Compaction per conversation.** The background-compaction coordinator reads its configuration per conversation. A
  bot sets an override for its own conversation and never writes the global `chat.backgroundCompaction` again.
- **Container environment.** The container carries the environment id, control token, gateway URL, keyring password
  and timezone. Bots are installed through the control API, with their profile, slot and gateway token.
- **Legacy adoption.** The first start of the new image on an old single-bot home volume (found by its
  `fleet.instance.profile` setting):
  - moves `fleet.instance.profile|paused` to the per-bot keys;
  - moves the queue, transcript extras and images into the per-bot folders;
  - re-keys memory rows from `bot-self` to `bot-self:<botId>`;
  - assigns slot 1.

  The adoption is idempotent.

### Instance API

- **Environment routes stay at `/v1/…`:** health, aggregate status, accounts, subscriptions, logins, skills, MCP
  servers, the environment screen, `ui/open` and the event stream.
- **Bot routes move under `/v1/bots/:botId/…`:**
  - profile (`PUT` installs or updates, `DELETE` uninstalls; `?purge=1` also deletes the bot's data);
  - status, selections, memories, transcript, images, inputs;
  - turn cancel, interactions, hold, conversation call;
  - screen (`browser` or `apps`, `view` or `control`).
- **Events.** Bot events carry `botId`.
- **Capability.** The status advertises `environments`. The gateway keeps the old unprefixed routes for instances
  without it, until they are restarted on the new image.

## Gateway

### Store (schema 6)

- **New tables:**
  - `environments`: id, name, lifecycle, setup, container name, volume name, memory limit, created, updated and
    archived timestamps;
  - `environment_secrets`: control token and keyring password.
- **Bots.** They gain `environment_id` and `slot`. The container lifecycle moves to the environment. A bot keeps only
  its own archived state, and its protocol `lifecycle` is derived: `archived` for an archived bot, otherwise the
  environment's lifecycle.
- **Secrets.** `bot_secrets` keeps the per-bot gateway token; the control token and keyring password move to the
  environment.
- **Owner memory.** `owner_memories` gains a nullable `environment_id` (null = global).
- **Migration.** Every existing bot becomes an environment:
  - the id and name of the environment are the bot's;
  - the container and volume keep their names (`maestrly-bot-<id>`, `maestrly-bot-<id>-home`);
  - the bot gets slot 1;
  - existing owner memories stay global.

  The migration runs in one transaction with integrity and foreign-key checks, and is tested from a schema-5 database.

### Lifecycle

- **Environment.**
  - Create: container, then desktop (health).
  - Start, stop, restart and update: they act on all of its bots.
  - Archive: the container is removed, the volume kept and every bot archived with it.
  - Restore, and purge (archived only, removes the volume).
- **New environments.** The container is `maestrly-env-<id>`, the volume `maestrly-env-<id>-home` and the label
  `org.maestrly.fleet.environment-id`.
- **Reconcile.** Reconciliation reads the environment label, falling back to the legacy bot label.
- **Bot.**
  - Create inside an environment: profile, then ready.
  - Archive: the instance uninstalls it, the data stays in the environment.
  - Restore: reinstall.
  - Purge: the instance deletes the bot's conversation, memory space and folders, then the gateway deletes its
    records.
- **Links and status.**
  - One SSE link per environment; bot events fan out by `botId`.
  - Bot status comes from the aggregate status and bot events.
  - Resources are measured per environment.
- **Memory limit.** It is set when the container is created and updated live (`docker update`) when the owner changes
  it.
- **Screen tickets.** A ticket names a surface: `browser`, `apps` or `environment`.
  - Bot surfaces require the bot's takeover for `control`.
  - The environment screen allows control without a hold: it only shows Maestrly's settings.
  - At most one `control` connection on `:0` (browser areas and environment screen) per environment.
- **Internal API.** Unchanged: the caller bot is still identified by its gateway token.

### Public API (protocol version stays 1; changes are additive)

- **Environments.**
  - `GET /v1/environments`, `POST /v1/environments` (`{ name, memoryLimitBytes? }`).
  - `GET` and `PATCH /v1/environments/:eid` (name, memory limit).
  - `POST /v1/environments/:eid/{start,stop,restart,archive}`.
  - `GET /v1/archived-environments`, `POST /v1/archived-environments/:eid/restore` and
    `DELETE /v1/archived-environments/:eid` (purge). Like archived bots, they are a separate collection so that an
    environment named `archived` cannot collide with them.
  - `POST /v1/environments/:eid/screen-tickets` and `POST /v1/environments/:eid/ui/open`.
- **Provisioning** moves to `/v1/environments/:eid/{accounts,subscriptions,logins,skills,mcp-servers}`. The bot routes
  added yesterday remain as aliases that resolve to the bot's environment.
- **`POST /v1/bots`** accepts either `environmentId` (existing environment) or `environment: { name }` (new one). With
  neither, as an older Mac sends it, it creates a new environment named after the bot.
- **Bot `start`, `stop` and `restart`** act on the environment when it has one bot. With more bots they answer
  `CONFLICT` ("This bot shares its environment. Restart the environment instead.").
- **Screen ticket.** `POST /v1/bots/:id/screen-tickets` gains `surface: 'browser' | 'apps'`, default `browser`.
- **Events.** New `environment.updated` and `environment.removed`.
- **Bot fields.** `FleetBot` gains `environmentId` (null for older gateways). `resources` stays filled only when the
  environment has one bot, so older Macs do not count memory twice.
- **Meta.** `/v1/meta` advertises the feature `environments`.

## Mac

- **State.** The state keeps environments next to bots, and bots are grouped by environment.
- **Sidebar, Bots tab.**
  - Each environment is a group: its header shows name, status, memory and bot count, and opens the environment view.
  - The bots are listed under it. Search matches environment names too.
  - The server card's memory bar has one segment per environment.
- **Create bot.**
  - A "Where it runs" choice with two option cards:
    - **New environment**, with a name defaulting to the bot's and the hint "Its own accounts, files and site logins";
    - **Existing environment**, with a searchable picker and the hint "Uses the accounts, skills, MCP servers and site
      logins of {{environment}}".
  - "Bring from your Mac" is offered only for a new environment.
  - Progress: `container → desktop → profile → ready` for a new environment; `profile → ready` for an existing one.
- **Environment view.** A new panel with:
  - its bots and a "New bot in this environment" button;
  - accounts, skills and MCP servers (the sections from yesterday, retargeted to the environment);
  - the environment screen, resources (memory, CPU, memory limit), restart or update (which says it restarts every bot),
    archive and permanent delete.
- **Bot settings.** The accounts, skills, MCP servers and "Where it runs" sections move to the environment. A line
  "Environment: {{name}}" links to it. "Archive" archives only this bot.
- **Bot screen.** A `Browser | Apps` switch.
- **Server view.** One row per environment (memory, CPU, uptime, restart, stop, start), with its bots under it.
- **Archived.** Archived environments, and archived bots of active environments, each with restore and permanent
  delete.
- **Compatibility.** Without the gateway feature `environments`, the Mac keeps today's UI.

## Security

- **Environments stay isolated from each other** exactly as bots are today: separate containers, volumes, keyrings and
  control tokens.
- **Inside an environment, bots trust each other.** A bot with shell access can read its neighbours' files,
  conversations and tokens, drive their displays and use their gateway tokens, for example to send a message as
  another bot. This is the accepted cost of sharing; the docs and the create dialog say so.
- **Secrets still flow only** Mac → gateway → environment and are never returned.
- **Activity.** Configuration activity (`bot_configured`) is recorded on the environment.
- **Takeover.** It still holds exactly one bot. Control on `:0` is exclusive per environment, so the owner's input
  never reaches two browser areas at once.

## Compatibility

- **Protocol.** Version 1; every new field has a default.
- **Older Mac, newer gateway.** Bots still list, chat and provision through the aliases. Bot restart and stop of a
  shared bot answer `CONFLICT`. The screen shows the browser area.
- **Newer gateway, older bot image.** Legacy instance routes keep working. Adding a second bot to an environment needs
  the `environments` capability: the Mac asks to update (restart) the environment first.
- **Store.** Schema 5 migrates to 6 in place; schemas newer than 6 are refused.

## Testing

- **Protocol.** Contracts for environments, surfaces, events, and the defaults for older peers.
- **Gateway.**
  - Migration from a schema-5 database.
  - Environment CRUD and lifecycle.
  - Bot create, archive, restore and purge inside an environment.
  - Event fan-out, screen tickets per surface with exclusive browser control.
  - Provisioning aliases, owner-memory scopes, and legacy instances.
- **Desktop (unit).**
  - Bot registry and per-bot storage; legacy adoption, including the memory re-key.
  - Lookups by conversation for tools, identity, gate and memory.
  - Compaction per conversation.
  - The display manager, with a fake spawner.
  - `computer_*` on the bot's display, and shell-environment injection for each runtime.
  - Instance routing.
- **Playwright.** Creating a bot in a new and in an existing environment, the environment view, the grouped sidebar
  and server view, the screen switch, and archive or restore of a bot versus an environment.
- **Container E2E.** An environment with two bots:
  - both run turns at the same time;
  - each types on its own apps display at the same time;
  - a cookie set by one bot's browser is seen by the other;
  - each gets a surface-scoped screen ticket, and a second control connection on `:0` is refused;
  - archiving one bot leaves the other running, and an environment restart brings both back.

  An isolated environment keeps passing every existing step. An old single-bot environment is adopted after an update.
