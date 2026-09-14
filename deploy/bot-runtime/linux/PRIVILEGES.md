# Bot privilege limits

Elevated operations are unsupported. `system_exec` returns `ELEVATION_UNSUPPORTED`
in both `ask` and `full-vm`, without requesting approval. This release does not
implement authenticated privileged approvals.

`ask` and `full-vm` control the provider sandbox and its ordinary command approval
policy only. Both execute as the unprivileged `maestrlybot` service account;
`full-vm` does not grant root. Files, browser, and ordinary Codex commands remain
available within that account's operating-system permissions.

The packaged sudoers file grants nothing. The legacy helper rejects every
operation, including direct `exec --` calls from native provider shells. Upgrades
must remove or overwrite the previous `/etc/sudoers.d/maestrly-bot` grant before
starting the runtime. A future privileged helper must authenticate authorization
outside the bot process; an in-process approval check cannot protect a helper
that the same user can invoke directly.
