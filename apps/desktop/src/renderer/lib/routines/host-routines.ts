import { isChatProviderConnected, type ChatConfig } from '../../../shared/chat'
import { type HostId, hostKey, isRemoteHostId, LOCAL_HOST_ID } from '../../../shared/host-key'
import type { HostView } from '../../../shared/hosts'
import {
  type LocalRoutine,
  type LocalRoutineRun,
  type RoutineModel,
  resolveRoutinePlace,
} from '../../../shared/routines'
import { chatProviderChoices } from '@/components/chat/account-pool'
import type { ModelPickerRow } from '@/components/chat/model-picker-rows'
import { hostSectionStatus, type HostSectionStatus } from '../hosts/host-status'
import { hostTint } from '../hosts/host-tint'

const noDeviceIds = () => null

/**
 * A host's routine as this computer shows it: its id keyed by its host, and its origin conversation by the host it is
 * on, as this computer names it (`hostId`, never a device id). An origin on a computer other than this one keeps its
 * title but no conversation.
 */
export function shellRoutine(
  hostId: HostId,
  routine: LocalRoutine,
  deviceIdOn: (serverId: string) => string | null = noDeviceIds
): LocalRoutine {
  let origin = routine.origin
  if (origin) {
    const originHostId = resolveRoutinePlace(hostId, origin, deviceIdOn)
    const { deviceId: _stored, ...rest } = origin
    origin =
      originHostId === null
        ? { ...rest, conversationId: '', hostId: null }
        : { ...rest, conversationId: hostKey(originHostId, origin.conversationId), hostId: originHostId }
  }
  if (hostId === LOCAL_HOST_ID) {
    return origin === routine.origin ? routine : { ...routine, origin }
  }
  return {
    ...routine,
    id: hostKey(hostId, routine.id),
    origin,
  }
}

export function shellRoutineRun(hostId: HostId, run: LocalRoutineRun): LocalRoutineRun {
  if (hostId === LOCAL_HOST_ID) return run
  return {
    ...run,
    id: hostKey(hostId, run.id),
    routineId: hostKey(hostId, run.routineId),
    conversationId: run.conversationId === null ? null : hostKey(hostId, run.conversationId),
  }
}

/**
 * Hosts that can run chat routines: this computer and server workspaces environments that advertise the routines
 * capability (excluding old server containers without the feature and peer computers).
 */
export function isRoutineHostCapable(host: Pick<HostView, 'remote' | 'routines' | 'peer'>): boolean {
  if (!host.remote) return true
  return host.routines && host.peer === null
}

export interface RoutineHostDisplay {
  hostId: HostId
  isRemote: boolean
  /** Primary display name: "This computer" for local, environment label for remote. */
  label: string
  /** Server name when remote and distinct from label. */
  server: string
  /** Combined display label, e.g. "Prod · My Server" or "This computer". */
  fullLabel: string
  tintRgb: [number, number, number]
  status: HostSectionStatus
  online: boolean
  stopped: boolean
  starting: boolean
  canStart: boolean
}

export function routineHostDisplay(
  host: HostView | undefined,
  hostId: HostId,
  t: (key: string, opts?: Record<string, unknown>) => string
): RoutineHostDisplay {
  const isRemote = isRemoteHostId(hostId)
  if (!isRemote) {
    const label = t('host.thisComputer')
    return {
      hostId: LOCAL_HOST_ID,
      isRemote: false,
      label,
      server: '',
      fullLabel: label,
      tintRgb: hostTint({ id: LOCAL_HOST_ID, remote: false, tint: null }),
      status: 'online',
      online: true,
      stopped: false,
      starting: false,
      canStart: false,
    }
  }

  const label = host?.label?.trim() || host?.server?.trim() || hostId
  const server = host?.server?.trim() && host.server.trim() !== label ? host.server.trim() : ''
  const fullLabel = server ? t('host.serverEnv', { env: label, server }) : label
  const status: HostSectionStatus = host ? hostSectionStatus(host) : 'offline'
  const online = status === 'online'
  const stopped = status === 'stopped' || status === 'failed'
  const starting = status === 'starting' || status === 'connecting' || status === 'reconnecting'
  const canStart = Boolean(host?.serverId && host.environment && stopped)

  return {
    hostId,
    isRemote: true,
    label,
    server,
    fullLabel,
    tintRgb: hostTint(host ?? { id: hostId, remote: true, tint: null }),
    status,
    online,
    stopped,
    starting,
    canStart,
  }
}

export function routineHostStatusLabel(
  status: HostSectionStatus,
  t: (key: string) => string
): string {
  if (status === 'online') return t('host.statusOnline')
  if (status === 'stopped' || status === 'failed') return t('host.statusStopped')
  if (status === 'starting') return t('host.statusStarting')
  if (status === 'connecting' || status === 'reconnecting') return t('host.statusConnecting')
  return t('host.statusOffline')
}

export interface RoutineModelValidation {
  status: 'unknown' | 'valid' | 'missing-provider' | 'missing-model'
  providerName?: string
}

/**
 * Validates whether a routine's provider/model is usable on a target host given its chatConfig and loaded model rows.
 */
export function validateRoutineModelForHost(
  model: Pick<RoutineModel, 'providerId' | 'modelId'>,
  config: ChatConfig | null,
  rows?: readonly ModelPickerRow[] | null,
  rowsPending = 0
): RoutineModelValidation {
  if (!config) return { status: 'unknown' }
  if (!model.providerId || !model.modelId) return { status: 'missing-model' }

  const choices = chatProviderChoices(config)
  const provider = choices.find((candidate) => candidate.id === model.providerId)
  if (!provider || !isChatProviderConnected(provider)) {
    return {
      status: 'missing-provider',
      providerName: provider?.name ?? model.providerId,
    }
  }

  if (rows && rows.length > 0) {
    const exactMatch = rows.some(
      (row) => row.providerId === model.providerId && row.modelId === model.modelId
    )
    if (exactMatch) return { status: 'valid', providerName: provider.name }
    const providerLoaded = rows.some((row) => row.providerId === model.providerId)
    if (providerLoaded || rowsPending === 0) {
      return { status: 'missing-model', providerName: provider.name }
    }
  } else if (rows && rowsPending === 0) {
    return { status: 'missing-model', providerName: provider.name }
  }

  return { status: 'valid', providerName: provider.name }
}

export interface HostRoutinesSnapshot {
  routines: readonly LocalRoutine[]
  runsByRoutine: Readonly<Record<string, readonly LocalRoutineRun[]>>
  timelineRunsByRoutine: Readonly<Record<string, readonly LocalRoutineRun[]>>
}

export function mergeHostRoutines(
  hostOrder: readonly HostId[],
  byHost: Readonly<Record<HostId, HostRoutinesSnapshot | undefined>>,
  deviceIdOn: (serverId: string) => string | null = noDeviceIds
): {
  routines: LocalRoutine[]
  runsByRoutine: Record<string, LocalRoutineRun[]>
  timelineRunsByRoutine: Record<string, LocalRoutineRun[]>
} {
  const routines: LocalRoutine[] = []
  const runsByRoutine: Record<string, LocalRoutineRun[]> = {}
  const timelineRunsByRoutine: Record<string, LocalRoutineRun[]> = {}

  for (const hostId of hostOrder) {
    const snap = byHost[hostId]
    if (!snap) continue
    for (const routine of snap.routines) {
      const keyed = shellRoutine(hostId, routine, deviceIdOn)
      routines.push(keyed)
      const runs = snap.runsByRoutine[routine.id]
      if (runs) runsByRoutine[keyed.id] = runs.map((run) => shellRoutineRun(hostId, run))
      const tl = snap.timelineRunsByRoutine[routine.id]
      if (tl) timelineRunsByRoutine[keyed.id] = tl.map((run) => shellRoutineRun(hostId, run))
    }
  }

  return { routines, runsByRoutine, timelineRunsByRoutine }
}
