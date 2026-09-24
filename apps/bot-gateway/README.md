# Bot gateway

Run `maestrly-bot-gateway serve` in the bot fleet container. The public API listens on
`127.0.0.1:7443` by default and the internal bot API listens on `0.0.0.0:7444`.
Configure the service with the `MAESTRLY_GATEWAY_*` variables in the fleet spec;
`MAESTRLY_GATEWAY_BOT_SECURITY_OPT` is a JSON array of Docker security options or
`auto`. With `auto`, the gateway reads `MAESTRLY_GATEWAY_BOT_SECCOMP_PROFILE`
(default `/etc/maestrly-bot/seccomp-bot.json`) and passes its inline JSON to Docker.
The screen WebSocket uses a short-lived ticket issued by the versioned API;
WebSocket clients do not send the fleet protocol header on the upgrade.

`pair` prints a code valid for ten minutes. `devices list` and
`devices revoke <id>` manage paired clients. `doctor` checks the data directory,
Docker API version, network, and bot image.

The SQLite database is stored in `MAESTRLY_GATEWAY_DATA_DIR/gateway.sqlite` with
mode 0600. It contains bot control and gateway tokens and each bot's stable keyring
password so they can be injected into
containers after a restart. The VPS root user can read these tokens. Protect the
host and its backups accordingly. The data directory uses mode 0700.
