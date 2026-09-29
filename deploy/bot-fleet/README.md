# Bot fleet: operator quick start

For bot controls, backups, security boundaries, and troubleshooting, see the [remote bots guide](../../docs/bot-fleet.md). This directory contains the gateway and bot Dockerfiles, Compose service, entrypoints, and bot seccomp profile.

On a Linux server with Docker Engine, the Compose plugin, and Tailscale, use the published images for the same version as the desktop app. From that version of the repository, run:

```sh
VERSION=0.9.4 # the desktop app's version, shown on its Server page
docker pull "ghcr.io/antonioducs/maestrly-bot-gateway:$VERSION"
docker pull "ghcr.io/antonioducs/maestrly-bot-instance:$VERSION"
cp deploy/bot-fleet/.env.example deploy/bot-fleet/.env
```

Set `MAESTRLY_GATEWAY_IMAGE=ghcr.io/antonioducs/maestrly-bot-gateway:<version>` and `MAESTRLY_GATEWAY_BOT_IMAGE=ghcr.io/antonioducs/maestrly-bot-instance:<version>` in `.env`, replacing `<version>` with the desktop app's version. Published images support linux/amd64 and linux/arm64. To build instead, run `node scripts/bot-fleet-images.mjs --platform linux/amd64` or use `linux/arm64` for ARM. The builder tags both images with the root package version and `:local`; it runs `npm ci` inside Docker. Point the two `.env` image settings at those tags.

Set `MAESTRLY_GATEWAY_DISPLAY_NAME` (up to 64 characters) to the VPS name shown on the app's **Server** page; when empty, the gateway uses its container hostname. Adjust `TZ`, `MAESTRLY_GATEWAY_BOT_MEMORY` (the memory limit of each environment without a limit of its own, default `4g`), and `MAESTRLY_GATEWAY_BOT_SHM` (shared memory per environment, default `1g`) for the host. `MAESTRLY_GATEWAY_BOT_EGRESS=open` lets environments reach private networks; set it to `public` to block private, host, link-local, CGNAT, remote loopback, multicast, and reserved destinations while keeping the fleet network and public internet reachable. The `public` guard runs in each environment and fails closed if it cannot install its rules. `MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES=auto` (the default) lets environments install new Claude Code and Codex releases on their own between tasks; set it to `off` to keep the versions of the bot image, which a bot's own **Settings → Components** can still update by hand. A change takes effect when each environment next starts or restarts. An environment hosts up to eight bots, and the desktop app can give an environment its own memory limit of 2 GiB or more. Then:

```sh
docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml up -d
docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml exec maestrly-bot-gateway maestrly-bot-gateway doctor
docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml exec maestrly-bot-gateway maestrly-bot-gateway pair
```

Compose publishes only the gateway public listener on `127.0.0.1:7443` by default. Expose that listener privately with Tailscale Serve (check your installed version's syntax), then choose **I already have a server** in **Settings → Bot server** of the desktop app and enter its HTTPS address and the one-use pairing code. Keep the gateway's internal `7444`, each environment's control port `7680`, and the VNC ports from `5900` to `5967` unpublished. An environment starts a passwordless VNC server only while a screen is open, bound to its container's loopback interface, and stops it a minute after its last client leaves. The gateway reaches these servers through authenticated control-server screen tunnels. Control of a bot's screen requires a takeover hold, and an environment allows one control session at a time on the display that its bots' browser areas and its settings screen share. Bots on the fleet network are denied access to the gateway public API, and the internal API accepts only fleet network and loopback clients.

The gateway uses the `maestrly-bots` Docker network and mounts the Docker socket to create environment containers. Socket access is effectively root access on the host. All environments share that network, and traffic between containers is not filtered. `MAESTRLY_GATEWAY_BOT_SECURITY_OPT=auto` applies the included seccomp profile, which allows the namespace syscalls Chromium's sandbox needs. Each environment runs in a `maestrly-env-<id>` container with its own persistent `maestrly-env-<id>-home` volume, shared by its bots. Environments migrated from single-bot containers keep their `maestrly-bot-<id>` container and `maestrly-bot-<id>-home` volume names. Back up those volumes and the Compose `gateway-data` volume together; host root can read their contents, including the gateway's plaintext environment control tokens, keyring passwords, and bot gateway tokens. See the [guide's security and data section](../../docs/bot-fleet.md#security-and-data).

To update, pull both images of the target version or rebuild them, set their tags in `.env`, then recreate the gateway with `docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml up -d --force-recreate`. The force flag also recreates the gateway when rebuilding the same `:local` tag. On its first start, a gateway from before environments migrates its database to schema 7 and turns each existing bot into an environment of one. Restart each environment from the app's **Server** page or its environment view to move it, and every bot in it, to the new image or egress setting. The container is replaced, while its home volume keeps accounts, site logins, files, and conversations; the first start of the new image adopts the data of a single bot from before environments. Running environments stay on their current image and egress setting until restarted.

After building the images, run `npm run test:e2e:bot-fleet` for an opt-in real-container check. It uses its own Compose project, network, loopback port, environments, bots, volumes, and local model, and includes an environment shared by two bots; it removes these resources at the end. Use `npm run test:e2e:bot-fleet -- --keep` to inspect the resources after a run. The separate browser-focus regression always removes its own container and volume and saves its report under `.bot-fleet-local/focus/`, even with `--keep`.

## Toolchain

The bot image includes Node.js 22.22.0 (npm, npx, corepack, pnpm and yarn), Python 3.11
(`python`, pip and venv), uv/uvx 0.12.15, mise v2026.9.10, git, ssh, build-essential,
ripgrep, fd, jq, sqlite3, zip/unzip, less, procps, file and xz. Node and its headers,
npm and corepack come from the app's build stage; uv and mise are pinned release
binaries verified with SHA-256 for arm64 and amd64. There is no Docker or sudo.
The toolchain adds about 0.23 GiB to the image.

Image-provided tools live outside `/home/bot` and update with the image. Installs
made with `npm -g`, `uv tool install`, `pip install --user` or mise live in the
environment's home volume, are shared by its bots, and survive updates. Plain and
login shells use the same toolchain PATH and npm prefix (`/home/bot/.local`). Use
`mise use node@20` for another Node version; once installed, a project's `.nvmrc` is
honored. Mise can also install other Python versions.
