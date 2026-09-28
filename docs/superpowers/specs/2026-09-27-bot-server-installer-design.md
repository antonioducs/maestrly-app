# Bot server installer: this computer or a VPS

## Goal

A person without server experience should get remote bots working from the Maestrly app alone. Today they rent a
VPS, install Docker, build two images from the repository at the app's version, start Compose, expose it through
Tailscale, run the pairing command inside the gateway container, and paste the code into Settings. The app should do
all of that, on this computer or on a VPS reached over SSH, and keep the server on the app's version.

## Decisions

| Topic | Decision |
| --- | --- |
| Where bots run | Settings → Bot server asks: **This computer** (its Docker), **A server (VPS)** (Maestrly installs over SSH), or **I already have a server** (today's address, pairing code, and device name form). |
| Images | The release workflow publishes `ghcr.io/antonioducs/maestrly-bot-gateway:<version>` and `ghcr.io/antonioducs/maestrly-bot-instance:<version>` for linux/amd64 and linux/arm64. The app installs the images of its own version. The packages are public. |
| Development builds | An unpackaged app uses `maestrly/bot-gateway:local` and `maestrly/bot-instance:local`, and builds them with `scripts/bot-fleet-images.mjs` when missing (this computer only). `MAESTRLY_BOT_SERVER_REGISTRY` and `MAESTRLY_BOT_SERVER_TAG` override the registry and the tag. |
| Docker on this computer | Required, never installed by Maestrly. It detects Docker Desktop, OrbStack, Colima, Rancher Desktop, or Docker Engine, and links to an installer when none is present. |
| Docker on a VPS | Installed by Maestrly with Docker's convenience script when missing. Supported: Ubuntu 22.04 or later and Debian 12 or later, on x86_64 or arm64. |
| SSH access | Log in as root, or as a user with passwordless sudo, with a password or a private key that is used once. Maestrly then authorizes its own ed25519 key, keeps it in the OS keyring, and pins the host key on first use. |
| Reaching the gateway | This computer: the gateway publishes on `127.0.0.1:<port>` (7443, or the next free port). VPS: an SSH tunnel from `127.0.0.1:<local port>` to the server's loopback port 7443. Nothing else is exposed, so neither Tailscale nor certificates are needed. |
| Pairing | Automatic: Maestrly runs `maestrly-bot-gateway pair` in the gateway container and connects with the code. |
| Updates | When the server is older than the app, the Bot server settings offer **Update server**, which installs the app's images and recreates the gateway. Environments move with **Update environment**, as today. Maestrly never downgrades; a newer server asks to update the app. |
| Joining an existing VPS | Setting up a second computer against a VPS that already has `/opt/maestrly-bots` only starts the gateway if needed and pairs; it never changes the server's version or settings, and ignores the form's network switch. The panel then shows the server's own setting. |
| Bot network access | New gateway setting `MAESTRLY_GATEWAY_BOT_EGRESS`: `open` (default, today's behavior) or `public`. Maestrly's installers set `public`, so environments cannot reach private, link-local, CGNAT, loopback, or host addresses: not this computer's services, not the server host, not cloud metadata. A switch in the installed panel allows them, for example for a local model. |
| Removal | **Disconnect this computer** revokes the device (on a VPS it also removes this computer's key) and leaves the server running. **Remove bot server** deletes every environment, the gateway, its data, and its images, after a typed confirmation. |
| Experimental | The Bots sidebar tab shows an **Experimental** badge. |

## Measurements (2026-09-27, development images `0.9.3`, arm64)

- `maestrly/bot-instance`: 6.76 GB uncompressed. `maestrly/bot-gateway`: 374 MB. A first installation downloads
  several gigabytes; the screens say so.

## Screens

Settings → Bot server, when this computer has no bot server:

1. **Where will your bots run?**
   - **This computer**: "Uses Docker on this computer. Bots stop when it sleeps or shuts down."
   - **A server (VPS)**: "An always-on Linux server. Maestrly installs everything over SSH."
   - A link, **I already have a server**, opens today's form unchanged.
2. **This computer** checks Docker and shows one state:
   - not found: an install link for the system (Docker Desktop on macOS and Windows, Docker Engine on Linux; OrbStack
     and Colima named as macOS alternatives) and **Check again**;
   - not running: "Open Docker and wait for it to start", **Check again**;
   - no permission (Linux): add the user to the `docker` group and sign in again;
   - Compose missing: install the Docker Compose plugin;
   - development fleet running (unpackaged app only): stop `npm run bot-fleet:dev` first;
   - ready: the engine and version; what to expect (bots stop when the computer sleeps; each environment can use up to
     4 GB of memory; the first download is several GB; bots cannot reach this computer's services unless allowed); the
     device name; the private network switch, off; **Install bot server**.
3. **A server (VPS)**: **Server address** (IP or host name), **User** (`root`), and **Password**. **Advanced options**:
   **SSH port** (22) and **Use a private key instead** (paste it or choose a file, with an optional passphrase). It
   lists the requirements (Ubuntu 22.04+ or Debian 12+, 4 GB of memory, 20 GB free) and says "Maestrly keeps an
   administrator key to this server on this computer." Then the device name, the private network switch (off), and
   **Install on the server**.
4. **Progress**, in both modes: the steps, the current step's detail and elapsed time, **Cancel** while it runs, and
   the error with **Try again** when it fails. Leaving Settings keeps the job running; coming back shows it.
   - This computer: Check Docker → Prepare files → Download images (or Build images, in a development build) → Start
     the server → Connect this computer.
   - VPS: Connect over SSH → Check the server → Install Docker (skipped when present) → Prepare files → Download
     images → Start the server → Open the tunnel → Connect this computer → Save access. The progress shows the
     server's host key fingerprint.
5. **Installed panel**, which replaces today's connected view:
   - where the server runs ("This computer", "Server 203.0.113.10 (SSH)", or the manual address), the connection
     state, and both versions;
   - **Update server** when the server is older than the app, or a note to update the app when it is newer;
   - the private network switch: "Let bots reach this computer and its local network" or "Let bots reach the server's
     private network", which applies to each environment when it restarts;
   - VPS tunnel problems: reconnecting; "The server's identity changed", which blocks the tunnel, explains it, and
     offers to set it up again with the password; "Sign in again" when the key could not be stored;
   - **Disconnect this computer**, and **Remove bot server** (this computer and VPS) with a typed confirmation.
   A manual server shows its address, state, and **Disconnect**, as today.

Elsewhere:

- The Bots sidebar tab shows an **Experimental** badge.
- With a server on this computer, the **Server** page says bots run here and stop when it sleeps, instead of "You can
  turn it off", and the routines note says the same.

## Images and releases

- Names: `ghcr.io/antonioducs/maestrly-bot-gateway:<version>` and `ghcr.io/antonioducs/maestrly-bot-instance:<version>`,
  where `<version>` is the release version without `v` (`0.9.4`, `0.9.4-beta.1`). The owner is `publish.owner` in
  `apps/desktop/electron-builder.yml`; the workflow derives it from the lowercased repository owner. Labels:
  `org.opencontainers.image.version` (read by **Update environment**), `org.opencontainers.image.source`,
  `org.opencontainers.image.revision`, and `org.opencontainers.image.licenses=MIT`. No `latest` tag: the app always
  pins its version.
- `release.yml`: after `validate`, a matrix builds each image natively on `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm`
  (arm64) and pushes it by digest. A second job merges the two digests into the version tag and checks that both
  platforms are present. `publish` needs it, so no release ships without its images. Only these two jobs get
  `packages: write`.
- The first published packages must be made public once in the organization's package settings; the releasing guide
  says so.
- A new workflow, `bot-fleet.yml`, runs on pull requests and pushes to `main` that touch the fleet, weekly, and on
  demand. It builds both images for amd64 without pushing and runs `npm run test:e2e:bot-fleet` against real
  containers. It is read-only and is not a required check.
- Image builds free runner disk first; the bot image is about 7 GB.

## Gateway and bot image

- `MAESTRLY_GATEWAY_BOT_EGRESS` (`FLEET_GATEWAY_ENV.botEgress`) is `open` (default) or `public`; any other value fails
  configuration. Compose passes it through with default `open`.
- `open`: environment containers are created as today (user 1000, no added capability).
- `public`: containers are created as user 0 with `NET_ADMIN`, `MAESTRLY_BOT_EGRESS=public`, and the label
  `org.maestrly.fleet.egress=public`. The entrypoint, still root, runs `/usr/local/bin/maestrly-egress-guard`, then
  `setpriv --reuid=1000 --regid=1000 --init-groups --bounding-set=-net_admin` and continues as today. Nothing started
  afterwards can regain `NET_ADMIN`, so the rules cannot be changed from inside. A container asked for `public` that
  did not start as root refuses to start.
- The guard changes only the container's own network namespace (the OUTPUT chain), never the host firewall:
  1. accept loopback and established or related traffic;
  2. reject the default route's gateway and the addresses of `host.docker.internal`, `gateway.docker.internal`,
     `host.internal`, `host.lima.internal`, and `host.orb.internal` when they resolve;
  3. accept the container's own link subnets (the fleet network: gateway, sibling environments, sidecars);
  4. reject 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24,
     192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, and 240.0.0.0/4; with IPv6, accept ICMPv6 and the kernel's own
     prefixes, then reject ::1, fc00::/7, fe80::/10, and ff00::/8;
  5. accept the rest, which is the public internet.
  It uses `iptables` (nft backend) and falls back to `iptables-legacy`. When neither works it fails closed: the
  container exits with an error and the environment reports a failed start.
- A container whose egress label differs from the configuration is recreated on its next start or restart, like an
  image change. A missing label counts as `open`.
- The bot image adds `iptables` and `iproute2`, and ships the guard.
- Pairing is unchanged. Maestrly reads the code from the `pair` command's output, `XXXX-XXXX (expires …)`, which older
  gateways print too.

## Desktop

### Main process: `src/main/fleet/installer/`

| File | Responsibility |
| --- | --- |
| `images.ts` | Image references for the app: packaged, GHCR at the app version, pulled; unpackaged, `:local`, built when missing; environment overrides. |
| `project.ts` | Project constants (`maestrly-bots`, the `maestrly-bot-gateway` service, `/opt/maestrly-bots`), the bundled `compose.yml` path, Compose arguments, and rendering and parsing of `.env`. |
| `runner.ts` | `CommandRunner` and `LocalRunner`. It finds the Docker CLI (PATH, `~/.docker/bin`, `~/.orbstack/bin`, `~/.rd/bin`, Docker.app, Program Files) and runs it with its own directory, and its symlink target's, first on PATH so credential helpers resolve. |
| `docker-host.ts` | Docker operations over any runner: status, image presence, pull and removal, project files, `compose up` and `down`, the published port, and pairing. |
| `ssh.ts` | `SshSession` over `ssh2`: password or key login, SHA256 host key fingerprint and pinning, `exec` with POSIX quoting (and `sudo -n` for non-root users), file writes, and forwarding to the server's loopback. `RemoteRunner` adapts it to `CommandRunner`. |
| `remote-host.ts` | VPS-only steps: probe (OS, architecture, memory, disk, sudo, Docker, Compose, an existing `/opt/maestrly-bots`), Docker installation, authorizing and revoking Maestrly's key, and removing the project directory. |
| `tunnel.ts` | The persistent tunnel from `127.0.0.1:<port>` to the server's port 7443, over a key session with keepalive and reconnect backoff from 1 s to 30 s. It stops on a host key mismatch. |
| `store.ts` | The install record in app settings (`fleet.installer`, validated) and the SSH private key in secure storage (`fleet.installer.sshKey`), or in memory when secure storage is unavailable. |
| `service.ts` | `FleetInstallerService`: one job at a time (install here, install on a VPS, update, private network, remove), progress, cancellation, status broadcasts, and the tunnel's startup and shutdown. |
| `ipc.ts` | IPC handlers with zod validation. |

- Files live in `<userData>/bot-server/` on this computer and in `/opt/maestrly-bots/` on a VPS (directory 0700, files
  0600): `compose.yml`, copied from the app, and `.env`, rendered by Maestrly. Compose runs with an explicit project
  name, directory, file, and env file. The app ships `deploy/bot-fleet/compose.yml` as an extra resource.
- `.env` holds both image references, `MAESTRLY_GATEWAY_BIND=127.0.0.1`, the port, the display name (this computer's
  or the server's host name), `MAESTRLY_GATEWAY_BOT_EGRESS`, and `TZ` from this computer's time zone.
- Port: on this computer, the recorded port, then the port the existing gateway publishes, then the first free port
  from 7443. A VPS tunnel reuses its recorded local port when free, or takes a new free port and retargets the fleet
  client without pairing again.
- Health: poll `GET /v1/meta` through the local port or the tunnel for up to two minutes.
- Pairing runs `docker compose … exec -T maestrly-bot-gateway maestrly-bot-gateway pair`, reads the code with
  `normalizePairingCode`, and calls `fleetClientService.connect` with `http://127.0.0.1:<port>`. It is skipped when
  this computer is already paired with that address.
- The install record is written only after pairing succeeds. A cancelled or failed job leaves files, images, and a
  running gateway, which the next attempt reuses.
- The record keeps the version whose images the server runs: the app's version after an install or an update, or the
  version read from the gateway image tag of an existing VPS. A tag that is not a version (`local`, a custom override)
  is unknown and offers an update.
- Update compares versions with `compareSemver` from `shared/update.ts`. After recreating the gateway it removes this
  registry's images of other versions, ignoring the ones still in use.
- Remove requires a connected fleet: it archives every active environment, deletes every archived environment and
  archived bot through the gateway API, disconnects, runs `compose down -v`, removes both images, and on a VPS revokes
  Maestrly's key and deletes `/opt/maestrly-bots`.
- `FleetClientService.retarget(origin)` moves a paired client to another loopback origin, keeping its token.
- Startup registers the installer before the fleet client and starts the tunnel of a VPS install; quitting closes it.

### Shared: `src/shared/fleet-installer.ts`

Types for the install record, status, jobs, steps, errors, and the Docker check on this computer. No Node or Electron
imports.

### Preload and renderer

- The `api-fleet-installer.ts` preload slice exposes `fleetInstallerStatus`, `fleetInstallerCheckLocal`,
  `fleetInstallerInstallLocal`, `fleetInstallerInstallRemote`, `fleetInstallerUpdate`, `fleetInstallerSetPrivateNetwork`,
  `fleetInstallerDisconnect`, `fleetInstallerRemove`, `fleetInstallerCancel`, and `onFleetInstallerStatus`.
- `lib/fleet/installer.ts` holds pure helpers (the steps of each job, which actions to offer, the version state), and
  `lib/fleet/use-fleet-installer.ts` the hook.
- Components live in `components/settings/bot-server/`. `FleetSettings` chooses between the setup flow and the
  installed panel. Copy lives in the `fleet` catalogs under `botServer`, in pt-BR and English. No native `<select>`.

## Security

- Maestrly's SSH key is root-equivalent on the VPS. It is generated on this computer (ed25519), kept in the OS
  keyring, and removed from the server by **Disconnect this computer** and **Remove bot server**. Without secure
  storage it stays in memory, and after a restart the panel asks for the password again.
- The password or private key typed during setup is used only by the running job; it is never stored or logged and is
  dropped when the job ends. Host, user, and port are validated and passed to `ssh2`, not to a shell.
- Host keys are pinned on first use. A different key stops the tunnel until the person sets it up again.
- Remote commands are fixed scripts; their arguments are POSIX-quoted.
- The gateway listens on loopback only, on this computer and on the VPS. The VPS is reached only through SSH.
- The gateway still controls the Docker engine it runs on; with a server on this computer, that is this computer's
  Docker.
- With `public` egress, environments cannot reach this computer, the server host, private networks, or cloud metadata.
  Allowing the private network restores today's behavior.

## Compatibility

- Existing manual installs keep working; their panel shows the manual address.
- The protocol stays at version 1. Older gateways ignore `MAESTRLY_GATEWAY_BOT_EGRESS`.
- Existing containers keep running until their next start or restart. With `public`, they are then recreated to start
  as root with the guard.
- `docker exec` into a `public` container defaults to root; operators pass `-u 1000` to act as the bot user.

## Testing

- Desktop unit tests: image references; `.env` rendering; Docker CLI discovery; Docker operations against a fake runner
  and a fake `docker` executable; probe parsing and support rules; quoting; host key fingerprints and pinning; the
  tunnel through an in-process `ssh2` server, including reconnection and a host key change; the service's jobs (steps,
  cancellation, failures, joining an existing VPS, update rules, removal); the store's validation and memory fallback;
  IPC validation; the preload inventory; renderer helpers, contracts, and translations.
- Gateway unit tests: `botEgress` configuration, the container specification in each mode, and recreation when the
  label differs.
- Policy tests: pinned actions (existing); the release's image jobs and `publish` dependencies; the read-only
  `bot-fleet.yml`; the packaged `compose.yml`; the registry owner matching `publish.owner`.
- Electron E2E: setup on this computer with a fake `docker` and a fake gateway; VPS setup through an in-process `ssh2`
  server; update; the manual form; the experimental badge.
- Container E2E: `test:e2e:bot-fleet` runs with `public` egress and checks that host, private, and metadata addresses
  are refused, that the gateway is reachable, and that bot processes lack `NET_ADMIN`.
- Real checks, recorded in the pull request: setup on this Mac (OrbStack) with local images; VPS setup against a
  temporary OrbStack Ubuntu machine with a local registry; `npm run verify:pr -- --full --package`.

## Out of scope

Creating the VPS through provider APIs, moving environments between servers, slimming the bot image, updating the
server automatically with the app, and testing on real Windows and Linux desktops (CI builds only).
