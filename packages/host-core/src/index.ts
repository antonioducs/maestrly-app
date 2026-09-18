/**
 * HostService API: new HostService({stateDirectory, runtimes, images, capacity?, templates?}).
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
 *
 * Phase 2 (schema 2): bot.* methods are delegated to BotService. A bot binds one VM;
 * its Linux runtime speaks over a private virtio-serial control port and reaches the
 * internet only through the egress broker (exact hostnames, ports 80/443, no literal,
 * private, link-local, multicast or Host addresses). Turns, interactions, memory and
 * files persist here; provider credentials persist only inside the guest.
 */
export { HostService, type HostServiceOptions } from './service.js'
export { QemuProvider, type Runtime, type Image, type Provider, type GuestPreparation } from './provider.js'
export { stageAsset, verifyAsset, type Asset } from './assets.js'
export { buildQemuArgs } from './qemu.js'
export type { BotTemplate, ResourceSpec } from './bots/recommendations.js'
export { recommendNewVm, assessExistingVm, pickTemplate } from './bots/recommendations.js'
export { HOST_DB_VERSION, migrateToV2 } from './bots/migrations.js'
export { SocketGuestSession, type GuestSession, type GuestConnector } from './guest/session.js'
export { botChannelPaths, botChannelArgs } from './guest/profile.js'
export { EgressBroker, type EgressBrokerOptions } from './egress/broker.js'
export { decide, isForbiddenAddress, normalizeAddress } from './egress/policy.js'
export { pinnedConnect } from './egress/resolver.js'
export { guestEgressFrameSchema, hostEgressFrameSchema, LineDecoder, STREAM_WINDOW } from './egress/streams.js'
export { resolveRecommendedModel } from './bots/accounts.js'
export { workspacePath } from './bots/files.js'
export { buildSnapshot, defaultInstructions, TURN_LIMITS } from './bots/context.js'
export type { VerifyResult } from '@maestrly/host-protocol'
export { handleDesktopAttach, type DesktopAttach } from './desktop/gateway.js'
export { DIRECT_CONTEXT, type DesktopContext } from './desktop/service.js'

/**
 * Phase 5 (schema 7): routine.* and voice.* are delegated to RoutineService and
 * VoiceService. A routine is a durable calendar entry that admits work into the engines that
 * already exist — one scoped turn per bot, one run per team — and is only ever activated by a
 * person confirming a preview. Voice messages are captured in the application, transcribed by
 * a separate worker process on the Host from a verified local bundle, and only the confirmed
 * text reaches the AI provider.
 */
export { nextOccurrences, latestDue, describeSchedule, resolveLocal, localReading, isAmbiguousInstant, type Clock, type CalendarOccurrence, type DueSummary } from './routines/calendar.js'
export { RoutineRepository } from './routines/repository.js'
export { RoutineService, type RoutineServiceOptions } from './routines/service.js'
export { RoutineAuthority } from './routines/authority.js'
export { BackgroundAdmission } from './teams/background-admission.js'
export { CompositeContinuationScope, OwnershipConflict, composeDispatchGuards, composeBudgetCeilings, composeTurnObservers } from './bots/scoped-execution.js'
export { VoiceRepository } from './voice/repository.js'
export { VoiceService, type VoiceServiceOptions } from './voice/service.js'
export { VoiceStorage } from './voice/uploads.js'
export { parseCanonicalWav, encodeCanonicalWav, decodePcm, isSilent, WAV_HEADER_BYTES } from './voice/wav.js'
export { inspectAsrBundle, resetAsrVerification, asrManifestSchema, type AsrBundle, type AsrBundleState } from './voice/assets.js'
export { AsrWorkerClient, asrRequestSchema, asrResponseSchema, type AsrOptions, type AsrWorkerFactory, type AsrWorkerHandle } from './voice/worker-client.js'
export { forkAsrWorker } from './voice/worker-process.js'
