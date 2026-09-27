# Bot gateway

The gateway is the Linux service for [remote bots](../../docs/bot-fleet.md). It owns device pairing, the lifecycle of environments and their bots, schedules, peer messaging, activity, and the screen proxy. An [environment](../../docs/bot-fleet.md#environments) is one container with one Maestrly desktop and one home volume, shared by up to eight bots. The public API defaults to `127.0.0.1:7443`; the internal bot API listens on port `7444` on the container network. See the [operator quick start](../../deploy/bot-fleet/README.md) for Docker deployment.

## Local development

From the repository root, with workspace dependencies already installed:

```sh
npm run dev:bot-gateway
npm run test --workspace @maestrly/bot-gateway
npm run check:bot-gateway
```

The dev command builds the fleet protocol and watches the gateway entry point. A functional local gateway also needs Docker Engine, a reachable socket, the `maestrly-bots` network, and a built bot image. Run `npm run build:bot-gateway` before using `node apps/bot-gateway/dist/main.js`. For a complete loopback fleet in Docker with a fake model, use `npm run bot-fleet:dev` as described in [trying it locally](../../docs/bot-fleet.md#trying-it-locally).

## Commands

| Command | Purpose |
| --- | --- |
| `serve` | Start the public and internal listeners and reconcile environment containers. Default command. |
| `pair` | Print a one-use pairing code, valid for ten minutes. |
| `devices list` | Show paired devices and revocation state. |
| `devices revoke <id>` | Revoke one device token. |
| `doctor` | Check the data directory, Docker API (at least 1.41), fleet network, and configured bot image. |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAESTRLY_GATEWAY_DATA_DIR` | `/data` | SQLite database and WAL files. |
| `MAESTRLY_GATEWAY_PUBLIC_HOST` | `127.0.0.1` | Public API bind address; Compose sets `0.0.0.0` inside the container and publishes to host loopback. |
| `MAESTRLY_GATEWAY_PUBLIC_PORT` | `7443` | Public API and screen proxy port. |
| `MAESTRLY_GATEWAY_INTERNAL_PORT` | `7444` | Bot-only API port. |
| `MAESTRLY_GATEWAY_INTERNAL_URL` | `http://maestrly-bot-gateway:7444` | Address given to environment containers. |
| `MAESTRLY_GATEWAY_BOT_IMAGE` | `maestrly/bot-instance:local` | Image for new environment containers; an existing environment moves to it when restarted. |
| `MAESTRLY_GATEWAY_NETWORK` | `maestrly-bots` | Docker network shared with environment containers. |
| `MAESTRLY_GATEWAY_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker Engine socket. |
| `MAESTRLY_GATEWAY_BOT_MEMORY` | `4g` | Memory limit of each environment that has no limit of its own; its bots share it. |
| `MAESTRLY_GATEWAY_BOT_SHM` | `1g` | Shared memory size per environment. |
| `MAESTRLY_GATEWAY_BOT_SECURITY_OPT` | `[]` | Docker security options as a JSON string array, or `auto` for the shipped profile. Compose sets `auto`. |
| `MAESTRLY_GATEWAY_BOT_SECCOMP_PROFILE` | `/etc/maestrly-bot/seccomp-bot.json` | Profile read when security options are `auto`. |
| `TZ` | `UTC` | Gateway and environment time zone; routines also carry their own time zone. |

The public API requires a paired device bearer token and the fleet protocol header. The screen WebSocket uses a short-lived ticket instead of the header on upgrade. The internal listener identifies each bot by its own gateway token.

## Environments and compatibility

- **Containers.** A new environment runs in `maestrly-env-<id>` with the home volume `maestrly-env-<id>-home`, both labelled `org.maestrly.fleet.managed` and `org.maestrly.fleet.environment-id`. `serve` finds each environment's container by that label, or by the `org.maestrly.fleet.bot-id` label of containers created before environments.
- **Store.** The database schema is 6, and older schemas migrate in place when the gateway opens them: every bot becomes an environment of one with the bot's id and name, keeping its `maestrly-bot-<id>` container, `maestrly-bot-<id>-home` volume, and secrets, with the bot in slot 1. An archived bot becomes an archived environment. The gateway refuses newer schemas, and older gateways cannot open schema 6, so back up the data directory before upgrading.
- **Protocol.** The fleet protocol stays at version 1, and `/v1/meta` advertises the `environments` feature. Macs from before environments keep using the bot routes, which act on the bot's environment where needed. An environment on a bot image from before environments keeps running its one bot through the original instance routes until it is restarted onto the current image.

See [compatibility](../../docs/bot-fleet.md#compatibility) for how each combination of Mac, gateway, and bot image behaves.

## Data and secrets

The data directory is mode 0700; `gateway.sqlite` is mode 0600. It stores in plaintext the secrets needed to restart containers: a control token and a keyring password per environment, and a gateway token per bot. Paired-device tokens and pairing codes are stored as hashes. Provider API keys transit the gateway when added but are stored only in the environment's encrypted credential store, in its home volume, where every bot of that environment can use them. Each environment's keyring password is also in its container's Docker metadata. The Docker socket and host root can access all of these, so protect the host and backups. Bots in one environment trust each other; see [security and data](../../docs/bot-fleet.md#security-and-data).
