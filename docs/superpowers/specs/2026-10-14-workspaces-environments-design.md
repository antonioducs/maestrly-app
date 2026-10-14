# Several workspaces environments per server

## Problem

A bot server hosts the owner's chats and workspaces in one **workspaces environment** (see
[remote hosts](2026-09-29-remote-hosts-design.md)). The owner works for several parties (personal work and more than one
company) and must not mix their credentials: Git and GitHub sign-ins, SSH keys, cloud CLIs, model accounts, MCP servers,
and the agent's site logins. One environment holds one set of all of them, and the only way to keep work apart today is
one server per party.

## Decisions

| Topic | Decision |
| --- | --- |
| Unit of separation | One **workspaces environment** per scope (for example Personal, Company A, Company B), each its own container, home volume, keyring, browser profile, accounts, skills, MCP servers, memory, conversations, and workspaces. A server hosts up to `FLEET_ENVIRONMENT_LIMITS.workspacesMax` (8) of them. |
| Server folder | Each environment gets a folder of its own under `MAESTRLY_GATEWAY_WORKSPACES_ROOT`: `<root>/<environment id>`, bind-mounted at the same path. An environment from before this change keeps the whole root (`shared`), so the paths of its workspaces keep working; the owner can move it to a folder of its own. |
| Creating the folder | The gateway does not mount the root. It runs a short-lived helper container from the bot image (no network, root user, only `CHOWN`, `DAC_OVERRIDE`, and `FOWNER`) that runs `install -d -o 1000 -g 1000 -m 0750` on the folder, as the VPS installer does for the root. |
| Network | Each workspaces environment gets a Docker bridge network of its own (`<fleet network>-env-<id>`). Only its container and the gateway join it; the gateway joins under the host name of its internal URL, so the environment reaches the gateway at the same address. Bots environments stay on the fleet network. |
| Finding the gateway's container | `MAESTRLY_GATEWAY_CONTAINER` when set; otherwise the member of the fleet network whose address is one of the gateway's own. Without it, a workspaces environment fails to start with a fixed message. |
| CPU | Every environment may have a CPU limit (`cpuLimit`, in CPUs, Docker `NanoCpus`), changed live like the memory limit. |
| Idle stop | A workspaces environment may stop itself after `idleStopMinutes` with no bridge, editor, or file transfer open and no chat turn running. Off by default. Bot environments do not have it: their routines run on their own. |
| Color | An environment may have a tint. The sidebar's machine switcher shows a workspaces environment with its name and tint, so the owner sees which scope a window lists. |
| Accounts | Unchanged: every environment already has its own accounts, skills, and MCP servers, provisioned per `environmentId`. A new environment starts with none; the owner brings what it needs from this computer or signs in there. |
| Applying to existing containers | Network and folder are fixed when a container is created. A container created with others reports `isolation.restartRequired`; restarting the environment (or the next update) recreates it. |

## Protocol

- Gateway feature `workspaces-environments` (`/v1/meta`). It is the 20th feature: desktops before this change accept at
  most 20, so `fleetFeaturesSchema` now accepts 40 for the next ones.
- `FleetEnvironment` gains, all defaulting for older gateways:
  - `tint: string | null`
  - `cpuLimit: number | null`
  - `idleStopMinutes: number | null`
  - `isolation: { network: 'own' | 'shared', folder: { mode: 'own' | 'shared' | 'none', path: string | null }, restartRequired: boolean } | null`
    (null for bot environments).
- `FleetCreateEnvironmentRequest` gains `tint`, `cpuLimit`, and `idleStopMinutes`; `FleetPatchEnvironmentRequest` gains
  those and `hostFolder: 'own' | 'shared'` (workspaces environments only).
- `FLEET_BRIDGE_LIMITS.perDevice` goes from 8 to 16, so a computer holds one bridge per environment with room for
  reconnections.
- No new activity kind (older desktops would refuse it): an idle stop is `environment_stopped` with `data.idle = true`.

## Gateway

- Store schema 13 adds `environments.tint`, `cpu_limit`, `idle_stop_minutes`, and `host_folder` (`own`, `shared`, or
  null for bot environments). Existing workspaces environments get `shared`; new ones get `own`.
- Lifecycle:
  - The one-workspaces-environment rule becomes the `workspacesMax` limit, on create and on restore.
  - Before creating a workspaces container: its network exists and the gateway joined it; its folder exists. Before
    starting an existing one: the gateway joined its network (a recreated gateway container starts on the fleet
    network only), and its folder exists.
  - Labels record the container's network and mounted folder; a mismatch with the environment's settings recreates the
    container on its next start or restart, as an image change does.
  - `reconcile` joins the networks of running workspaces containers before their health checks.
  - Archiving or deleting removes the network once its container is gone. Folders are never deleted: they hold the
    owner's files.
  - An idle check runs every minute for environments with `idleStopMinutes`: it counts the bridges, editor connections,
    and file transfers open to it (the proxies count them) and asks its health whether a chat runs.
- `FleetNetwork` reads the subnets of the fleet network and of every environment network, so the internal API accepts
  workspaces environments and the public API refuses them, as for bots. It is refreshed when a network is created.

## Desktop

- `HostRegistry` labels a workspaces host with its environment's name and passes its tint and the server's name.
- The **Server** page lists every workspaces environment with its state and actions, and **New workspaces
  environment** opens a dialog: name, color, memory and CPU limits, and idle stop. After creation the environment's page
  opens, where accounts are added or brought from this computer.
- An environment's page shows its CPU limit and, for workspaces, idle stop next to the memory limit, and an
  **Isolation** section: its network, its folder (with a warning while it mounts the whole shared folder and **Use a
  folder of its own**), and a restart prompt when its container predates its settings.
- The host notice's **Manage** opens the host's environment page instead of the server page.

## Compatibility

- Older desktops show the first workspaces environment on the Server page; their `HostRegistry` already connects to
  all of them. They ignore the new fields.
- Older gateways keep refusing a second workspaces environment; the desktop offers only one without the feature.
- Schema 13 cannot be opened by older gateways; back up the gateway volume before upgrading, as for earlier schemas.

## Security

- Containers of different scopes share no volume, no folder (once each has its own), and no network. They still share
  the Docker host, its kernel, and the owner's pairing: anyone with root on the server, or with a paired device, reaches
  all of them. Strong separation (for example a company that forbids its code on a shared machine) still needs separate
  servers.
- The helper container mounts only the configured root, has no network, and runs one fixed command whose path is built
  from the environment id (a slug).

## Testing

- Gateway unit tests with the fake Docker driver: several workspaces environments and the limit, folders and the
  helper, networks and the gateway joining them (create, start, reconcile, archive, delete), labels and recreation,
  CPU limits, idle stop, the schema 13 migration, and `FleetNetwork` with several networks.
- Desktop unit tests: `HostRegistry` labels and tints, selectors, the create IPC validation, and the new components.
- The container end-to-end test (`test:e2e:bot-fleet:workspaces`) covers two environments with their own networks and
  folders on the real images.
