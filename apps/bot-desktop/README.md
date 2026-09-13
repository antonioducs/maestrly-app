# Maestrly Bot desktop

Local Electron lab console for the Phase 1 host RPC service. Run from the repository root:

- `npm run dev --workspace @maestrly/bot-desktop`
- `npm run check --workspace @maestrly/bot-desktop`
- `npm run test:e2e --workspace @maestrly/bot-desktop`
- `node scripts/package-bot-lab.mjs`

The packaging script creates an unpacked local application with publishing disabled and no signing identity discovery. The bundle identifier is `io.github.antonioducs.maestrly.bot`. Development, packaged lab, and automated fixtures use distinct application-data and session directories, selected before locking or loading stores. This is a separate application from Maestrly Desktop.

Configure and trust an SSH alias with the system SSH client first. Bot invokes `/usr/bin/ssh` with strict host checking, batch mode, no forwarded agent or ports, and only the fixed remote command `/Library/MaestrlyHost/bin/maestrly-host rpc-stdio`. No installer or remote shell is exposed. The main process validates IPC senders and method-specific payloads. The renderer uses a sandboxed CommonJS preload.

Mutation keys and exact validated requests are persisted in the main process before sending. Accepted operation IDs are stored with the SSH alias and stable host ID. Reconnect inspects pending operations before mutations are enabled, including after restarting the app. An unknown response is never replayed automatically: the UI displays its request key and blocks fresh mutations while the operator inspects host operations. There is intentionally no automatic resolution or journal-clear button for uncertain requests. A definite protocol rejection does not leave an uncertain request behind.

Removal retains disk data by default. Checking **Delete VM data permanently** changes the action to **Delete VM and data** and sends `deleteData: true`; unchecked sends `false`. Retained disks removed through this app have a separate inspection list that is recovered from the journal after reopening. They remain part of host storage allocation. Disks removed through other clients cannot be enumerated by the current `vm.list` protocol. Events poll after the latest sequence and retain a bounded 300-entry viewer; diagnostic data is sanitized in the main process. VM desired state, observed state, health, and host service identity are shown separately. Operations display their real status without invented progress percentages.

The Playwright test launches the actual built Electron renderer with a local main-process fixture enabled only for unpackaged apps. Fixture events and deliberate operation failures are labeled. This validates desktop behavior, not SSH reachability, guest boot, HVF, QEMU, or macOS hardware. Packaged applications ignore the fixture environment switch.


The packaged startup suite is `test/e2e/host-management.spec.ts`; use `BOT_PACKAGED_EXECUTABLE` to select an existing local executable, or build the default local package. It never connects SSH. Packaging runs this suite and emits `dist/lab/inventory.json` with app/Electron versions, architecture, ASAR SHA256, and observed identity/sandbox checks, without timestamps or publishing. Local fixture testing remains in `desktop.spec.ts` and uses a per-process fixture journal; durable cross-reopen recovery is exercised with isolated temporary journals in unit tests.
