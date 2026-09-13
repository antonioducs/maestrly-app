/**
 * HostService API: new HostService({stateDirectory, runtimes, images, capacity?}).
 * await service.dispatch({version:1,id,method,params}) always returns a wire Response.
 * Mutations return a durable Operation immediately; poll operation.get for completion.
 * await service.ready() performs conservative recovery. await service.close() drains
 * accepted work and closes SQLite; it does not terminate guests. One service owns a
 * state directory. It must be canonical, owned by the current UID, mode 0700,
 * and short enough that <stateDirectory>/vms/<uuid>/qmp.sock fits in 100 bytes.
 * Assets must be explicit absolute paths with SHA256 checksums.
 * host.inspect returns Host; vm.list/image.list/events.list return arrays;
 * vm.inspect returns Vm; operation.get/cancel and VM mutations return Operation.
 * events.list emits {seq,kind,value,createdAt}; pass the last seq as `after`.
 * vm.create completes only after QMP running, synchronized QGA, provisioned marker
 * and isolated loopback network readiness; Vm.health is independent of process state.
 * vm.verify({vmId,mode:'write-marker'|'read-marker'}) returns VerifyResult. Paths and
 * marker content are fixed internally; only /usr/bin/sync may be guest-executed.
 * vm.remove defaults deleteData=false. Removed retained disks still reserve disk
 * capacity; an explicit deleteData=true purge may be retried at current revision.
 * startupPolicy defaults manual; always restarts proven stopped desired-running VMs
 * on service recovery, excluding interrupted operations.
 * Cancellation is supported only while queued. All non-removed VMs reserve their
 * declared capacity, including stopped and unknown VMs. Interrupted operations
 * are failed with INTERRUPTED and are never replayed. Idempotency keys persist.
 * Images must already include cloud-init and qemu-guest-agent; guests have no NIC.
 * Unknown VM identity blocks mutations and requires administrator reconciliation.
 * No arbitrary process arguments, QMP, guest commands, paths, or network settings
 * are accepted in the wire protocol. Runtime/image catalogue is administrator input.
 */
export { HostService, type HostServiceOptions } from './service.js'
export { QemuProvider, type Runtime, type Image, type Provider } from './provider.js'
export { stageAsset, verifyAsset, type Asset } from './assets.js'
export { buildQemuArgs } from './qemu.js'

export type { VerifyResult } from '@maestrly/host-protocol'
