# Bot fleet: operator quick start

For bot controls, backups, security boundaries, and troubleshooting, see the [remote bots guide](../../docs/bot-fleet.md). This directory contains the gateway and bot Dockerfiles, Compose service, entrypoints, and bot seccomp profile.

On a Linux server with Docker Engine and Tailscale, build from the same repository version as the Mac app. Choose the server architecture:

```sh
node scripts/bot-fleet-images.mjs --platform linux/amd64
# Or: node scripts/bot-fleet-images.mjs --platform linux/arm64
cp deploy/bot-fleet/.env.example deploy/bot-fleet/.env
```

The builder tags both images with the root package version and `:local`; it runs `npm ci` inside Docker. Set `MAESTRLY_GATEWAY_IMAGE` and `MAESTRLY_GATEWAY_BOT_IMAGE` in `.env` to the versioned tags. Set `MAESTRLY_GATEWAY_DISPLAY_NAME` (up to 64 characters) to the VPS name shown on the Mac's Server page; when empty, the gateway uses its container hostname. Adjust `TZ`, `MAESTRLY_GATEWAY_BOT_MEMORY` (default `4g`), and `MAESTRLY_GATEWAY_BOT_SHM` (default `1g`) for the host. Then:

```sh
docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml up -d
docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml exec maestrly-bot-gateway maestrly-bot-gateway doctor
docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml exec maestrly-bot-gateway maestrly-bot-gateway pair
```

Compose publishes only the gateway public listener on `127.0.0.1:7443` by default. Expose that listener privately with Tailscale Serve (check your installed version's syntax), then enter its HTTPS address and the one-use pairing code in **Settings → Bot server** on the Mac. Keep the gateway's internal `7444` and bot `7680`, `5900`, and `5901` ports unpublished. The passwordless VNC listeners bind only to each bot's loopback interface. The gateway reaches them through authenticated control-server screen tunnels; control tunnels require a takeover hold. Bots on the fleet network are denied access to the gateway public API, and the internal API accepts only fleet network and loopback clients.

The gateway uses the `maestrly-bots` Docker network and mounts the Docker socket to create bot containers. Socket access is effectively root access on the host. `MAESTRLY_GATEWAY_BOT_SECURITY_OPT=auto` applies the included seccomp profile, which allows the namespace syscalls Chromium's sandbox needs. Each bot receives its own persistent `maestrly-bot-<id>-home` volume. Back up those volumes and the Compose `gateway-data` volume together; host root can read their contents, including the gateway's plaintext bot control tokens and keyring passwords. See the [guide's security and data section](../../docs/bot-fleet.md#security-and-data).

To update, rebuild both images, set their tags in `.env`, then recreate the gateway with `docker compose --env-file deploy/bot-fleet/.env -f deploy/bot-fleet/compose.yml up -d --force-recreate`. The force flag also recreates the gateway when rebuilding the same `:local` tag. Restart each bot from the Mac's **Server** page or its menu to move it to the new image. The bot container is replaced, while its home volume keeps accounts, logins, files, and conversation. Running bots stay on their current image until restarted.

After building the images, run `npm run test:e2e:bot-fleet` for an opt-in real-container check. It uses its own Compose project, network, loopback port, bots, volumes, and local model, then removes them. Use `npm run test:e2e:bot-fleet -- --keep` to inspect the resources after a run.

## Toolchain

The bot image includes Node.js 22.22.0 (npm, npx, corepack, pnpm and yarn), Python 3.11
(`python`, pip and venv), uv/uvx 0.12.15, mise v2026.9.10, git, ssh, build-essential,
ripgrep, fd, jq, sqlite3, zip/unzip, less, procps, file and xz. Node and its headers,
npm and corepack come from the app's build stage; uv and mise are pinned release
binaries verified with SHA-256 for arm64 and amd64. There is no Docker or sudo.
The toolchain adds about 0.23 GiB to the image.

Image-provided tools live outside `/home/bot` and update with the image. Installs
made with `npm -g`, `uv tool install`, `pip install --user` or mise live in the bot's
home volume and survive updates. Plain and login shells use the same toolchain
PATH and npm prefix (`/home/bot/.local`). Use `mise use node@20` for another Node
version; once installed, a project's `.nvmrc` is honored. Mise can also install
other Python versions.
