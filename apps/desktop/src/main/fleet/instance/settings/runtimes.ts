import type { FleetEnvironmentSettingsService, FleetSettingsOutput } from '@maestrly/bot-fleet-protocol'
import type { UpdatableRuntimeAssetId } from '../../../../shared/runtime-assets'
import { runtimeAssetProgressInfo, runtimeUpdates } from '../../../runtime-assets/app-service'
import { runtimesInUse } from '../runtimes'
import { InstanceHttpError } from '../server'
import { settingsRevision, withSettingsRevision } from './revisions'

type Runtime = FleetSettingsOutput<'runtimeAction'>
type RuntimeId = Runtime['id']
type Action = Runtime['allowedActions'][number]
const assets: Record<RuntimeId, UpdatableRuntimeAssetId> = {
  'claude-code': 'claude-code-runtime',
  codex: 'codex-runtime',
  'antigravity-acp': 'antigravity-acp-runtime',
}
// Operations belong to the environment process, never to a settings view or request lifetime.
const active = new Map<RuntimeId, Exclude<Action, 'cancel'>>()
const cancelled = new Set<RuntimeId>()
const failures = new Map<RuntimeId, NonNullable<Runtime['error']>>()
const installing = new Set(['downloading', 'verifying', 'installing', 'validating', 'rolling-back'])
const resource = (id: RuntimeId): string => `runtime:${id}`
const version = (value: string | null | undefined): string | null =>
  value && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/.test(value) ? value : null

function asset(id: RuntimeId): UpdatableRuntimeAssetId {
  if (!Object.hasOwn(assets, id)) throw new InstanceHttpError(400, 'INVALID_REQUEST', 'Unknown runtime.')
  return assets[id]
}

function controllerFor(assetId: UpdatableRuntimeAssetId): ReturnType<typeof runtimeUpdates> {
  try {
    return runtimeUpdates(assetId)
  } catch {
    throw new InstanceHttpError(503, 'INSTANCE_UNAVAILABLE', 'Runtime service is unavailable.')
  }
}

async function snapshot(id: RuntimeId): Promise<Runtime> {
  const assetId = asset(id)
  const revision = settingsRevision(resource(id))
  try {
    const info = await runtimeAssetProgressInfo(assetId)
    const update = info.update
    const selected = version(
      info.provided?.active ? info.provided.version : info.status.state === 'ready' ? info.status.version : null
    )
    const behind = selected
      ? runtimesInUse(id).find((runtime) => runtime.version && runtime.version !== selected)
      : undefined
    const operation = active.get(id)
    const checking = update?.state === 'checking' || operation === 'check'
    const busy =
      Boolean(operation) || checking || installing.has(update?.state ?? '') || installing.has(info.status.state)
    // Rollback ignores AbortSignal in the native controller; pending activation is not an operation.
    const cancellable = busy && operation !== 'rollback' && update?.state !== 'rolling-back'
    const allowedActions: Action[] = busy ? (cancellable ? ['cancel'] : []) : ['check']
    if (!busy) {
      if (!selected) allowedActions.push('install')
      else if (update?.availableVersion) allowedActions.push('update')
      if (selected && update?.rollbackVersion) allowedActions.push('rollback')
    }
    const error: Runtime['error'] =
      failures.get(id) ??
      (update?.error === 'cancelled'
        ? null
        : update?.error === 'check-failed'
          ? 'check-failed'
          : update?.error === 'rollback-unavailable'
            ? 'rollback-failed'
            : update?.error || info.status.state === 'failed' || info.status.state === 'corrupt'
              ? 'install-failed'
              : null)
    const downloaded = update?.bytesDownloaded ?? info.status.bytesDownloaded
    const total = update?.totalBytes ?? info.status.totalBytes
    const progress =
      busy && Number.isFinite(downloaded) && Number.isFinite(total) && total! > 0
        ? Math.max(0, Math.min(100, (downloaded! / total!) * 100))
        : null
    return {
      id,
      revision,
      currentVersion: version(behind?.version) ?? selected,
      pendingVersion: behind ? selected : null,
      availableVersion: version(update?.availableVersion),
      source: behind?.source ?? (info.provided?.active ? 'image' : 'managed'),
      automatic: update?.automatic ?? false,
      allowedActions,
      state: busy ? (checking ? 'checking' : 'installing') : error ? 'error' : selected ? 'ready' : 'idle',
      progress,
      error,
      rollbackVersion: version(update?.rollbackVersion),
    }
  } catch {
    return {
      id,
      revision,
      currentVersion: null,
      pendingVersion: null,
      availableVersion: null,
      source: 'managed',
      automatic: false,
      allowedActions: [],
      state: 'error',
      progress: null,
      error: 'unavailable',
      rollbackVersion: null,
    }
  }
}

export const runtimes: FleetEnvironmentSettingsService['runtimes'] = async () => ({
  runtimes: await Promise.all((Object.keys(assets) as RuntimeId[]).map(snapshot)),
})

export const runtimeAction: FleetEnvironmentSettingsService['runtimeAction'] = async (input) => {
  const assetId = asset(input.id)
  await withSettingsRevision(resource(input.id), input.expectedRevision, async () => {
    const before = await snapshot(input.id)
    if (!before.allowedActions.includes(input.action)) {
      throw new InstanceHttpError(409, 'CONFLICT', 'Runtime action is not available.')
    }
    const controller = controllerFor(assetId)
    if (input.action === 'cancel') {
      if (!controller.cancel()) throw new InstanceHttpError(409, 'CONFLICT', 'No cancellable runtime operation.')
      cancelled.add(input.id)
      return
    }
    const action = input.action
    active.set(input.id, action)
    failures.delete(input.id)
    cancelled.delete(input.id)
    const fail = (): void => {
      if (!cancelled.has(input.id))
        failures.set(
          input.id,
          action === 'check' ? 'check-failed' : action === 'rollback' ? 'rollback-failed' : 'install-failed'
        )
    }
    try {
      const task = action === 'install' ? controller.installInitial() : controller[action]()
      void task
        .then((result) => {
          if (result.error && result.error !== 'cancelled') fail()
        })
        .catch(fail)
        .finally(() => active.delete(input.id))
    } catch {
      active.delete(input.id)
      fail()
    }
  })
  return snapshot(input.id)
}

export const setRuntimeAutomatic: FleetEnvironmentSettingsService['setRuntimeAutomatic'] = async (input) => {
  const assetId = asset(input.id)
  await withSettingsRevision(resource(input.id), input.expectedRevision, async () => {
    try {
      await runtimeUpdates(assetId).setAutomatic(input.automatic)
    } catch {
      throw new InstanceHttpError(503, 'INSTANCE_UNAVAILABLE', 'Runtime preference could not be saved.')
    }
  })
  return snapshot(input.id)
}
