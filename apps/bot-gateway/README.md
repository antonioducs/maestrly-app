# Bot gateway

The gateway is the Linux service for [remote bots](../../docs/bot-fleet.md). It owns device pairing, bot lifecycle, schedules, peer messaging, activity, and the screen proxy. The public API defaults to `127.0.0.1:7443`; the internal bot API listens on port `7444` on the container network. See the [operator quick start](../../deploy/bot-fleet/README.md) for Docker deployment.

## Local development

From the repository root, with workspace dependencies already installed:

```sh
npm run dev:bot-gateway
npm run test --workspace @maestrly/bot-gateway
npm run check:bot-gateway
```

The dev command builds the fleet protocol and watches the gateway entry point. A functional local gateway also needs Docker Engine, a reachable socket, the `maestrly-bots` network, and a built bot image. Run `npm run build:bot-gateway` before using `node apps/bot-gateway/dist/main.js`.

## Commands

| Command | Purpose |
| --- | --- |
| `serve` | Start the public and internal listeners and reconcile managed containers. Default command. |
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
| `MAESTRLY_GATEWAY_INTERNAL_URL` | `http://maestrly-bot-gateway:7444` | Address given to bot containers. |
| `MAESTRLY_GATEWAY_BOT_IMAGE` | `maestrly/bot-instance:local` | Image used for new bots. |
| `MAESTRLY_GATEWAY_NETWORK` | `maestrly-bots` | Docker network shared with bots. |
| `MAESTRLY_GATEWAY_DOCKER_SOCKET` | `/var/run/docker.sock` | Docker Engine socket. |
| `MAESTRLY_GATEWAY_BOT_MEMORY` | `4g` | Per-bot memory limit. |
| `MAESTRLY_GATEWAY_BOT_SHM` | `1g` | Per-bot shared memory size. |
| `MAESTRLY_GATEWAY_BOT_SECURITY_OPT` | `[]` | Docker security options as a JSON string array, or `auto` for the shipped profile. Compose sets `auto`. |
| `MAESTRLY_GATEWAY_BOT_SECCOMP_PROFILE` | `/etc/maestrly-bot/seccomp-bot.json` | Profile read when security options are `auto`. |
| `TZ` | `UTC` | Gateway and bot time zone; routines also carry their own time zone. |

The public API requires a paired device bearer token and the fleet protocol header. The screen WebSocket uses a short-lived ticket instead of the header on upgrade. The internal listener authenticates each bot separately.

The data directory is mode 0700; `gateway.sqlite` is mode 0600. Its bot control tokens, gateway tokens, and per-bot keyring passwords are stored in plaintext for container restarts. Paired-device tokens and pairing codes are stored as hashes. Provider API keys transit the gateway when added but remain in the bot's own encrypted credential store. The Docker socket and host root can access all of these, so protect the host and backups.
