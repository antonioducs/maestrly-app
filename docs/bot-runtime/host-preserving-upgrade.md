# Preserving upgrade on the mini

This is an administrator-run local procedure. It has not been executed on the mini.
The existing authorization covers backup and restart of `lab-mini-linux-1`; it
is not authorization to interrupt other guests or bot work. No noninteractive
administrator access is available. Run the commands in an interactive admin
terminal on the mini, after reviewing the package and its manifest digest.

1. Prepare the verified native Host package at
   `/private/var/tmp/maestrly-host-package`. The directory and every entry must be
   root-owned, free of symlinks and not writable by group or others. Obtain the
   manifest SHA256 from the trusted build output, independently of the staged files.
2. Disconnect other Host clients for the entire maintenance window. Finish or
   cancel bot work. Shut down `lab-mini-linux-1` through the Host UI and wait until
   stopped. If another guest is active, arrange its own authorized window first.
   The upgrade does not issue guest shutdowns. Ensure sufficient space under
   `/Library/MaestrlyHost/backups` for a complete copy of state, including disks.
3. Inspect real preflight evidence (read-only):

   ```sh
   sudo env MAESTRLY_UPGRADE_WINDOW=1 MAESTRLY_UPGRADE_BACKUP=1 \
     /private/var/tmp/maestrly-host-package/runtime/bin/node \
     /private/var/tmp/maestrly-host-package/install/check-upgrade.mjs \
     /private/var/tmp/maestrly-host-package
   ```

   This command assumes the package has already been verified. The upgrade script
   below repeats package verification and compatibility checks before preflight.
   Evidence comes from the fixed installed `rpc-stdio` client: `host.inspect`,
   `vm.list(includeRetained)`, and, when bot capabilities are advertised,
   `bot.list(includeArchived)` plus referenced setup operations and turns.
   The legacy Host has no bot capabilities and needs no bot RPC. Bot support still
   uses wire envelope version 1. Each subprocess has a five-second kill deadline
   and 1 MiB output limit; collection also has a one-minute deadline checked before
   each request. Unknown states, missing data, errors and invalid envelopes block.
4. Run the preserving upgrade, replacing the digest placeholder:

   ```sh
   sudo /bin/sh /private/var/tmp/maestrly-host-package/install/upgrade.sh \
     --authorize-upgrade TRUSTED_64_CHARACTER_MANIFEST_SHA256 --window-confirmed
   ```

The script rechecks live evidence, stops launchd, refuses any remaining QEMU
process owned by the service account, copies the entire offline state and creates
and integrity-checks a SQLite `.backup`. It saves configuration, manifest, launchd
plist and previous code before replacing application code and launchers. It never
moves or overwrites the installed runtime, images, bot assets, configuration,
quotas or catalogues. Candidate Node must match the measured installed Node
version. A Node/QEMU or catalogue migration requires a separate reviewed procedure;
this upgrade alone does not install new bot images/templates. The candidate
manifest records the application package provenance, while the preserved runtime
is the one described by the backup's manifest.

After startup, the script checks Host health through bounded RPC. Inspect the VM
inventory, image references and reservations against `backups/<stamp>/preflight.json`.
Restart `lab-mini-linux-1` explicitly if it did not start automatically under its
existing startup policy, then verify the guest. Keep clients disconnected until
validation finishes. The maintenance window prevents new work racing the final
preflight; this is not a daemon-level exclusive upgrade lock.

If backup or staging fails before code replacement, the script attempts to restart
the unchanged service. A failure during replacement leaves the service offline and
prints the backup path. A startup/health failure requires local inspection; the
service may already be running. Do not blindly start or downgrade it. Stop launchd
and ensure QEMU is stopped, retain the failed installation for diagnosis, then
restore `app`, `bin`, `install`, `etc`, `manifest.json` and the complete `state`
directory from the same backup, preserving ownership. Restore the saved launchd
plist if changed. Keep the runtime untouched. Bootstrap launchd and verify Host
and guest health. Do not restore only the old app against a migrated database;
restore the matching offline state as well. Never overwrite live guest disks.
