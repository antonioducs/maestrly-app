import { app } from 'electron'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { isUpdatableRuntimeAssetId } from '../../shared/runtime-assets'
import type {
  RuntimeAssetId,
  RuntimeAssetInfo,
  RuntimeAssetLease,
  RuntimeAssetPublicStatus,
  RuntimeAssetStatus,
  RuntimeAssetUpdateInfo,
  UpdatableRuntimeAssetId,
} from '../../shared/runtime-assets'
import { getAppSetting, setAppSetting } from '../store/app-settings'
import { isE2E } from '../test-mode'
import { CLAUDE_CODE_COMPATIBILITY_REVISION, validateClaudeCodeRuntime } from './claude-code-compatibility'
import { CLAUDE_CODE_RELEASE_PROFILE, discoverClaudeCodeRelease } from './claude-code-releases'
import { CODEX_COMPATIBILITY_REVISION, validateCodexRuntime } from './codex-compatibility'
import { CODEX_RELEASE_PROFILE, compareStableVersions, discoverCodexRelease } from './codex-releases'
import { RUNTIME_ASSET_REGISTRY, hostRuntimeTarget } from './registry'
import { CLAUDE_CODE_RELEASE_STORE_KEY, CODEX_RELEASE_STORE_KEY, RuntimeReleaseStore } from './release-store'
import { RuntimeUpdateController } from './runtime-updates'
import { RuntimeAssetService } from './service'
import { createBundledRuntimeDownloader } from './downloader'

let service: RuntimeAssetService | null = null
const releaseStores = new Map<UpdatableRuntimeAssetId, RuntimeReleaseStore>()
const updateControllers = new Map<UpdatableRuntimeAssetId, RuntimeUpdateController>()
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

const RELEASE_CHANNELS = {
  'codex-runtime': { profile: CODEX_RELEASE_PROFILE, key: CODEX_RELEASE_STORE_KEY },
  'claude-code-runtime': { profile: CLAUDE_CODE_RELEASE_PROFILE, key: CLAUDE_CODE_RELEASE_STORE_KEY },
} as const satisfies Record<UpdatableRuntimeAssetId, unknown>

/** Persisted metadata of independently installed releases of one runtime (local SQLite app settings). */
export function releaseStore(id: UpdatableRuntimeAssetId): RuntimeReleaseStore {
  let store = releaseStores.get(id)
  if (!store) {
    const { profile, key } = RELEASE_CHANNELS[id]
    store = new RuntimeReleaseStore({
      profile,
      storage: {
        read: () => getAppSetting(key),
        write: (value) => setAppSetting(key, value),
      },
      target: hostRuntimeTarget(),
      embedded: RUNTIME_ASSET_REGISTRY[id],
    })
    releaseStores.set(id, store)
  }
  return store
}

export function codexReleaseStore(): RuntimeReleaseStore {
  return releaseStore('codex-runtime')
}

export function runtimeAssetService(): RuntimeAssetService {
  service ??= new RuntimeAssetService({
    userDataPath: app.getPath('userData'),
    downloader: createBundledRuntimeDownloader(
      app.isPackaged
        ? path.join(process.resourcesPath, 'local-ml')
        : path.join(app.getAppPath(), 'runtime-assets', 'local-ml', 'archives')
    ),
    // Consulted only for an updatable runtime installation whose version differs from the embedded pin.
    acceptedDefinition: (id, version) =>
      isUpdatableRuntimeAssetId(id) ? releaseStore(id).acceptedDefinition(version) : null,
    onStatusChanged: (status) => scheduleRuntimeAssetChanged(status.id),
  })
  return service
}

function createRuntimeUpdates(id: UpdatableRuntimeAssetId): RuntimeUpdateController {
  switch (id) {
    case 'codex-runtime':
      return new RuntimeUpdateController({
        profile: CODEX_RELEASE_PROFILE,
        compatibilityRevision: CODEX_COMPATIBILITY_REVISION,
        service: runtimeAssetService(),
        store: codexReleaseStore(),
        target: hostRuntimeTarget(),
        embedded: RUNTIME_ASSET_REGISTRY['codex-runtime'],
        discover: (target, signal) => discoverCodexRelease(target, signal),
        validate: (installationPath, definition, signal) =>
          validateCodexRuntime(installationPath, definition, signal, { clientVersion: app.getVersion() }),
        onChanged: () => scheduleRuntimeAssetChanged('codex-runtime'),
        schedule: app.isPackaged && !isE2E(),
      })
    case 'claude-code-runtime':
      return new RuntimeUpdateController({
        profile: CLAUDE_CODE_RELEASE_PROFILE,
        compatibilityRevision: CLAUDE_CODE_COMPATIBILITY_REVISION,
        service: runtimeAssetService(),
        store: releaseStore('claude-code-runtime'),
        target: hostRuntimeTarget(),
        embedded: RUNTIME_ASSET_REGISTRY['claude-code-runtime'],
        discover: (target, signal) => discoverClaudeCodeRelease(target, signal),
        validate: (installationPath, definition, signal) =>
          validateClaudeCodeRuntime(installationPath, definition, signal),
        onChanged: () => scheduleRuntimeAssetChanged('claude-code-runtime'),
        schedule: false,
      })
  }
}

/** Independent release channel of one runtime; scheduling is enabled only in packaged, non-E2E builds. */
export function runtimeUpdates(id: UpdatableRuntimeAssetId): RuntimeUpdateController {
  let controller = updateControllers.get(id)
  if (!controller) {
    controller = createRuntimeUpdates(id)
    updateControllers.set(id, controller)
  }
  return controller
}

export function codexRuntimeUpdates(): RuntimeUpdateController {
  return runtimeUpdates('codex-runtime')
}

export { listedRuntimeAssetIds } from './visibility'

export function startRuntimeAssetUpdates(): void {
  codexRuntimeUpdates().start()
}

export function disposeRuntimeAssetUpdates(): void {
  for (const controller of updateControllers.values()) controller.dispose()
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
  'claude-code-runtime': { displayName: 'Claude Code runtime', requiredBy: 'Claude' },
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
  'whisper-model': {
    displayName: 'Voice model',
    requiredBy: 'Voice dictation',
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

/**
 * Version a first install of an updatable runtime would receive: the latest checked stable release when newer than
 * the embedded pin and not rejected, otherwise the pin. Other assets always install their embedded version.
 */
function installableDefinition(id: RuntimeAssetId) {
  const embedded = RUNTIME_ASSET_REGISTRY[id]
  if (!isUpdatableRuntimeAssetId(id)) return embedded
  try {
    const store = releaseStore(id)
    const candidate = store.candidate()
    const newer = candidate && (compareStableVersions(candidate.version, embedded.version) ?? 0) > 0
    return newer && store.rejected()?.version !== candidate.version ? candidate : embedded
  } catch {
    return embedded
  }
}

async function buildRuntimeAssetInfo(id: RuntimeAssetId, includeDiskUsage: boolean): Promise<RuntimeAssetInfo> {
  const runtimeService = runtimeAssetService()
  const status = await runtimeService.status(id).catch(
    (error: unknown): RuntimeAssetStatus => ({
      id,
      state: 'failed',
      error: error instanceof Error ? error.message : String(error),
    })
  )
  const update: RuntimeAssetUpdateInfo | undefined = isUpdatableRuntimeAssetId(id)
    ? await runtimeUpdates(id).snapshot()
    : undefined
  const definition = installableDefinition(id)
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
    ...(update ? { update } : {}),
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
      .filter((entry) =>
        /^\.tmp-(?:codex-runtime|github-copilot-runtime|tunnel-client|local-ml-runtime|whisper-model)-/.test(entry)
      )
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
  const installed = isUpdatableRuntimeAssetId(id)
    ? await runtimeUpdates(id).installInitial(signal)
    : await runtimeAssetService().install(id, signal)
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
  for (const controller of updateControllers.values()) controller.dispose()
  updateControllers.clear()
  releaseStores.clear()
  service = null
  diskUsageCache.clear()
}
