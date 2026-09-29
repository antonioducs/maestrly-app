# One-click bot update

## Goal

Show the owner that their bots can be updated, and update them with one click without cutting any bot off mid-work.
Today the server and each environment are updated separately, from different screens, and restarting an environment
interrupts whatever its bots are doing.

## Decisions

| Topic | Decision |
| --- | --- |
| The one click | **Update bots** updates the server when the app installed it and it is older than the app, then schedules an update of every running environment whose container runs an older image than the configured one. It needs no confirmation: nothing is interrupted. |
| Busy bots | The environment waits. The gateway restarts it on the configured image once none of its bots is busy. The owner can still **Update now** (interrupts, confirmed) or **Cancel**. |
| Where the wait lives | In the gateway. The environment being updated runs the old image, which knows no new instance command, and the wait must continue while the Mac is off. |
| Busy | A bot is busy while its status is `working`, `waiting` (an interaction awaits the owner) or `human` (the owner took over its screen). Every other status (`idle`, `paused`, `setup`, `starting`, `offline`) counts as idle: those bots start no turn on their own, and their queue survives the restart. |
| Work arriving while waiting | Owner messages and **Run now** are delivered as usual: the owner asked for them. Scheduled routine runs are skipped as `skipped_busy`. Peer messages stay in the gateway's pending deliveries and are delivered after the restart. |
| Stopped or failed environments | Not started. They already move to the configured image at their next start; the app says so. |
| Server version | The version the gateway reports (`FleetHostInfo.gatewayVersion`, the release version baked into its image) and, during an update, the tag of the gateway image in the server's `.env`. The version this Mac recorded is only a fallback. This closes the downgrade described below. |
| Servers the app did not install | The app cannot replace their images. It says that the server is older than the app and to update both server images as the bot fleet guide describes; environment updates still work in one click once the gateway supports them. |
| Out of scope | Automatic updates without a click, and a minimum version enforced by the gateway. |

### The downgrade this fixes

`FleetInstallerService` compares the app with `record.version`, which is what this Mac wrote when it installed or last
updated the server, and `update()` rewrites both image tags without reading the current ones. If another Mac moved the
server to a newer version, an older app offers **Update server** and replaces the newer images; a gateway whose
database schema is newer than its binary then refuses to start (`store.ts`: "Gateway database schema is newer than
this binary").

## Protocol (version 1, additive)

- Feature `environment-updates` in `/v1/meta` `features`.
- `/v1/meta` reports the gateway's real version (`HostMonitor.gatewayVersion`) instead of the literal `'0.1.0'`.
- `FleetEnvironment.update`, nullable, default `null` (a gateway without the feature):

  ```ts
  {
    /** The environment's container runs an image other than the configured bot image. */
    available: boolean
    /** When the owner scheduled the update; null when none is waiting. */
    pendingSince: string | null
  }
  ```

- `FLEET_UPDATE_BUSY_STATUSES = ['working', 'waiting', 'human']` and `fleetBotBlocksUpdate(bot)` in the protocol
  package: the one busy rule, used by the gateway to decide and by the Mac to show who the update waits for (from each
  bot's live `status`, so there is no list to go stale).
- `POST /v1/environments/:eid/update`, body `{ when: 'idle' | 'now' }`, response `FleetEnvironment`.
  - `idle`: inspects the environment's container and the configured image again (so a retagged image counts without a
    gateway restart), schedules the update and answers at once with `pendingSince` set. It never waits for the
    restart, even when every bot is already idle. Scheduling again keeps the first `pendingSince`. Without an available
    update it answers the environment unchanged. An environment that is not running answers `BOT_NOT_RUNNING`.
  - `now`: restarts the environment as `/restart` does (awaited, recreating the container on the configured image),
    which clears any pending update.
- `DELETE /v1/environments/:eid/update` cancels a pending update and answers the environment.
- No new activity kinds or event types: older Macs parse those with closed enums. Completion is the existing
  `environment_restarted` activity with `updated: true`; state changes travel in `environment.updated`.

## Gateway

- **Schema 8.** `environments.update_requested_at TEXT` (nullable). Migration 7 → 8, in the existing transaction with
  its integrity and foreign-key checks; schemas newer than 8 are refused.
- **Available.** `update.available` is the existing `imageOutdated` state (container image id ≠ configured image id),
  computed at reconcile and at each start. It replaces the version-label comparison for gateways with the feature, so
  a rebuilt image with the same version (such as `:local`) also shows as an update.
- **Pending.** Set by `when: 'idle'`. Cleared at the start of every start, restart (the drain's, **Update now**'s or a
  plain one) and stop of the environment, when the owner cancels, when it is archived or deleted, and when reconcile
  finds no update available any more or the container not running.
- **Drain.** `maybeUpdate(environmentId)` runs after each status update of a bot in a pending environment, right after
  the update is scheduled, after reconcile, and every 30 seconds while any update is pending. When no active bot of the
  environment is busy, it takes the environment's lock, checks again with the statuses current at that moment, and
  restarts the environment the way `restartEnvironment` does, which recreates its container on the configured image.
  A failed restart fails the environment as today and clears the pending update; starting the environment again
  recreates it on the configured image anyway.
- **Residual race.** An owner message arriving between the last check and the container stop can start a turn that is
  then interrupted. The owner caused both actions, and the message itself stays in the queue.
- **While pending.** `Routines.fire` records scheduled runs of bots in the environment as `skipped_busy`.
  `Peers.deliver` returns `false` for a target in a pending environment, so the message stays pending, and the
  existing retry on bot readiness (`server.ts`, `peers.retry(id)`) delivers it after the restart.
- **Restart and reconcile.** A pending update survives a gateway restart, including the one caused by updating the
  server: reconcile recomputes `available`, then either clears the pending update or resumes the drain.

## Mac

### Knowing an update exists

A renderer selector, `botUpdateSummary`, combines the installer status, the fleet snapshot and the app version into:

- `server`: `update` (the app can update it), `behind` (older than the app, not installed by this app: notice
  pointing to the guide), `newer` (existing warning), or `current`;
- per environment: `available`, `pending` (with the busy bots), `nextStart` (stopped or failed with an update
  available), or `current`. An environment from a gateway without the feature (`update === null`) falls back to the
  existing label comparison (`environmentUpdateAvailable`) and to the existing immediate **Update environment**.

An update is available when the server is `update` or `behind`, or an environment is `available`.

### Where it shows

- **Bots tab:** an arrow icon next to the experimental flask while an update is available or pending, with
  screen-reader text.
- **Bots sidebar:** a banner under the server card: "Update available" with the target version and **Update bots**.
  While it runs: the server step ("Updating the server…"), then "Updating environments: waiting for Ana and Bob to
  finish" with **Update now** and **Cancel**. A server the app cannot update shows the `behind` notice instead of the
  button.
- **Environment header (sidebar):** an arrow icon when an update is available, a clock while pending.
- **Environment view:** **Update environment** schedules the update (gateway with the feature). While pending, it lists
  each busy bot with its reason from its status (working, waiting for your answer, you control its screen), the time
  waited, **Update now** (confirmation naming the busy bots) and **Cancel**. A stopped environment says it updates at
  its next start.
- **Server page:** the same banner as the sidebar.
- **Settings → Bot server:** the **Update server** button runs the same one-click action and is renamed **Update
  bots**.

### The one-click action

A main-process `fleet:updateBots` IPC:

1. When the server can be updated, runs the existing installer update job with one more step,
   `environment-updates` (the `environments` step id already names "Remove environments"). The job refuses to
   downgrade: in its `files` step it reads the gateway image tag from the server's `.env`, and if that version is
   newer than the app it records it and stops with `server-newer`.
2. The `environment-updates` step (or, without a server update, the whole action) waits until the fleet client is
   connected to a gateway that offers `environment-updates`, lists the environments from the gateway, then sends
   `POST …/update { when: 'idle' }` for each running environment with an update available and none pending. Each
   environment fails on its own; the result names the failed ones, and since they still show an available update the
   banner's button stays to try again.
3. A gateway without `environment-updates` (a server the app did not install and nobody updated) leaves the
   environments to their existing **Update environment** button.

Whether the server can be updated comes from one shared function, `knownServerVersion(recordVersion,
reportedVersion)`: the version the connected gateway reports when it is a release version, else `record.version`.
The main process uses it for the installer's `update` state and guard; the renderer uses it with the live host info,
so the display does not wait for an installer status broadcast.

## Error handling

| Case | Behaviour |
| --- | --- |
| Server update fails or is cancelled | The existing job failure view; no environment is scheduled. The banner offers **Try again**. |
| Server newer than the app | No one-click; the existing "update the app" warning. |
| Scheduling one environment fails | The others are scheduled; the banner names the failed one and offers **Try again**. |
| Restart fails while draining | The environment fails as today; the pending update is cleared. |
| Mac offline after scheduling | The gateway finishes each environment on its own. |
| A bot never becomes idle | The environment keeps waiting; the owner sees why and can **Update now** or **Cancel**. |

## Testing

- **Protocol:** an environment payload without `update` parses as `null`; `update` round-trips.
- **Gateway (strict fakes, never permissive ones):** migration 7 → 8 and refusal of schema 9; scheduling on running,
  stopped and up-to-date environments; the drain restarts only when no bot is `working`, `waiting` or `human`, and
  rechecks under the lock; `now` and cancel; pending cleared by stop, archive, delete and a reconcile without an
  update; pending resumed after a gateway restart; scheduled routines skipped as busy while pending, **Run now** still
  delivered; peer messages held, then delivered after the restart; `/v1/meta` version.
- **Desktop main:** the installer refuses to downgrade when the server's `.env` or the reported gateway version is
  newer; `update` state from the reported version; the `environment-updates` step schedules only running environments with an
  update, tolerates one failure, and waits for the feature.
- **Desktop renderer:** `botUpdateSummary` cases (including the fallback for gateways without the feature); the
  banner, tab icon and environment view states in the fake-server e2e, including one click through to a pending
  environment and **Update now** confirmation.
- **Container e2e (`test:e2e:bot-fleet`):** retag the bot image so a running environment is outdated, schedule its
  update while its bot is working on the fake model, check it waits, then that it is recreated on the new image with
  its home volume and conversation once the turn ends.

## Documentation

`docs/bot-fleet.md` (update section, manual-server notes, the waiting behaviour and what is skipped or held meanwhile)
and the English and Brazilian Portuguese strings.
