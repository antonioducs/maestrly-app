import { app } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  RuntimeAssetId,
  RuntimeAssetInfo,
  RuntimeAssetLease,
  RuntimeAssetPublicStatus,
  RuntimeAssetStatus,
} from '../../shared/runtime-assets'
import { RUNTIME_ASSET_REGISTRY, hostRuntimeTarget } from './registry'
import { RuntimeAssetService } from './service'
import { createBundledRuntimeDownloader } from './downloader'

let service: RuntimeAssetService | null = null
const diskUsageCache = new Map<RuntimeAssetId, number>()
const runtimeAssetNotificationTimers = new Map<RuntimeAssetId, ReturnType<typeof setTimeout>>()
const pendingRuntimeAssetNotifications = new Set<RuntimeAssetId>()
let emitRuntimeAssetChanged: ((info: RuntimeAssetInfo) => void) | null = null
const RUNTIME_ASSET_NOTIFICATION_THROTTLE_MS = 150

export class RuntimeAssetComponentRequiredError extends Error {
  readonly code = 'RUNTIME_ASSET_COMPONENT_REQUIRED'

  constructor(
    readonly assetId: RuntimeAssetId,
    detail?: string
  ) {
    super(
      `${assetId} is required but is not installed. Use the provider setup or sign-in action to install it.` +
        (detail ? ` ${detail}` : '')
    )
    this.name = 'RuntimeAssetComponentRequiredError'
  }
}

export function runtimeAssetService(): RuntimeAssetService {
  service ??= new RuntimeAssetService({
    userDataPath: app.getPath('userData'),
    downloader: createBundledRuntimeDownloader(
      app.isPackaged
        ? path.join(process.resourcesPath, 'local-ml')
        : path.join(app.getAppPath(), 'runtime-assets', 'local-ml', 'archives')
    ),
    onStatusChanged: (status) => scheduleRuntimeAssetChanged(status.id),
  })
  return service
}

function scheduleRuntimeAssetChanged(id: RuntimeAssetId): void {
  if (!emitRuntimeAssetChanged) return
  pendingRuntimeAssetNotifications.add(id)
  if (runtimeAssetNotificationTimers.has(id)) return
  const timer = setTimeout(() => {
    runtimeAssetNotificationTimers.delete(id)
    if (!pendingRuntimeAssetNotifications.delete(id)) return
    void runtimeAssetProgressInfo(id)
      .then((info) => emitRuntimeAssetChanged?.(info))
      .catch(() => {
        // Progress is best-effort; the operation result and the next status probe remain authoritative.
      })
  }, RUNTIME_ASSET_NOTIFICATION_THROTTLE_MS)
  runtimeAssetNotificationTimers.set(id, timer)
}

/** Installs the process-wide renderer sink; service callers do not need to know about IPC. */
export function setRuntimeAssetChangedEmitter(emit: (info: RuntimeAssetInfo) => void): void {
  emitRuntimeAssetChanged = emit
}

const DISPLAY: Record<RuntimeAssetId, Pick<RuntimeAssetInfo, 'displayName' | 'requiredBy'>> = {
  'codex-runtime': { displayName: 'Codex runtime', requiredBy: 'Codex' },
  'github-copilot-runtime': {
    displayName: 'GitHub Copilot runtime',
    requiredBy: 'GitHub Copilot',
  },
  'tunnel-client': {
    displayName: 'Secure tunnel client',
    requiredBy: 'ChatGPT Web',
  },
  'local-ml-runtime': {
    displayName: 'Local ML runtime',
    requiredBy: 'Local AI features',
  },
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const child = path.join(root, entry.name)
      if (entry.isDirectory()) total += await directoryBytes(child)
      else if (entry.isFile()) total += (await stat(child)).size
    }
  } catch {
    return total
  }
  return total
}

async function buildRuntimeAssetInfo(id: RuntimeAssetId, includeDiskUsage: boolean): Promise<RuntimeAssetInfo> {
  const runtimeService = runtimeAssetService()
  const status = await runtimeService.status(id)
  const definition = RUNTIME_ASSET_REGISTRY[id]
  const target = definition.targets[hostRuntimeTarget()]
  const diskUsageBytes = includeDiskUsage
    ? await directoryBytes(path.join(runtimeService.root, id))
    : (diskUsageCache.get(id) ?? 0)
  if (includeDiskUsage) diskUsageCache.set(id, diskUsageBytes)
  const safeStatus: RuntimeAssetPublicStatus = {
    id,
    state: status.state,
    version: status.version,
    bytesDownloaded: status.bytesDownloaded,
    totalBytes: status.totalBytes,
    diskUsageBytes,
    error:
      status.error?.startsWith('Insufficient disk space') || status.error?.includes('cancelled')
        ? status.error
        : status.error
          ? 'Component operation failed. Retry or repair the component.'
          : undefined,
  }
  return {
    id,
    ...DISPLAY[id],
    availableVersion: definition.version,
    downloadBytes: target?.downloadBytes ?? 0,
    unpackedBytes: target?.unpackedBytes ?? 0,
    status: safeStatus,
  }
}

/** Full snapshot for status/list and operation results; includes the current disk footprint. */
export function runtimeAssetInfo(id: RuntimeAssetId): Promise<RuntimeAssetInfo> {
  return buildRuntimeAssetInfo(id, true)
}

/** Hot-path snapshot for in-flight progress; it never walks the asset directory. */
export function runtimeAssetProgressInfo(id: RuntimeAssetId): Promise<RuntimeAssetInfo> {
  return buildRuntimeAssetInfo(id, false)
}

/** Startup recovery is intentionally cleanup-only: it never calls install(). */
export async function cleanupOrphanRuntimeAssetTemps(): Promise<void> {
  const root = runtimeAssetService().root
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  await Promise.all(
    entries
      .filter((entry) => /^\.tmp-(?:codex-runtime|github-copilot-runtime|tunnel-client|local-ml-runtime)-/.test(entry))
      .map((entry) => rm(path.join(root, entry), { recursive: true, force: true }))
  )
}

/** Read-only: this helper never starts an install or download. */
export async function readyRuntimeAsset(id: RuntimeAssetId): Promise<RuntimeAssetStatus> {
  const status = await runtimeAssetService().status(id)
  if (status.state !== 'ready' || !status.path) {
    throw new RuntimeAssetComponentRequiredError(id, status.error)
  }
  return status
}

/** Reserved for explicit user actions such as provider sign-in/setup. */
export async function ensureRuntimeAsset(id: RuntimeAssetId, signal?: AbortSignal): Promise<RuntimeAssetStatus> {
  if (signal?.aborted) throw signal.reason ?? new Error('Runtime asset installation cancelled')
  const current = await runtimeAssetService().status(id)
  if (current.state === 'ready' && current.path) return current
  const installed = await runtimeAssetService().install(id, signal)
  if (installed.state !== 'ready' || !installed.path) {
    throw new RuntimeAssetComponentRequiredError(id, installed.error ?? `Installation ended in ${installed.state}.`)
  }
  return installed
}

export function acquireRuntimeAssetLease(id: RuntimeAssetId, expectedPath?: string): Promise<RuntimeAssetLease> {
  return runtimeAssetService().acquireLease(id, expectedPath)
}

export function resetRuntimeAssetAppServiceForTests(): void {
  for (const timer of runtimeAssetNotificationTimers.values()) clearTimeout(timer)
  runtimeAssetNotificationTimers.clear()
  pendingRuntimeAssetNotifications.clear()
  emitRuntimeAssetChanged = null
  service = null
  diskUsageCache.clear()
}
