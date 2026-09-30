import { FLEET_BOT_ENV } from '@maestrly/bot-fleet-protocol'
import { app } from 'electron'
import { accessSync, constants } from 'node:fs'
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
import { bundledClaudeCandidate } from '../chat/claude-agent-sdk/resolve-claude'
import { resolveCodexRuntime } from '../chat/codex-subscription/runtime-resolver'
import { isBotMode } from '../fleet/instance/config'
import { getAppSetting, setAppSetting } from '../store/app-settings'
import { isE2E } from '../test-mode'
import { CLAUDE_CODE_COMPATIBILITY_REVISION, validateClaudeCodeRuntime } from './claude-code-compatibility'
import { CLAUDE_CODE_RELEASE_PROFILE, discoverClaudeCodeRelease } from './claude-code-releases'
import { CODEX_COMPATIBILITY_REVISION, validateCodexRuntime } from './codex-compatibility'
import { CODEX_RELEASE_PROFILE, compareStableVersions, discoverCodexRelease } from './codex-releases'
import { CLAUDE_CODE_PINNED_VERSION, RUNTIME_ASSET_REGISTRY, hostRuntimeTarget } from './registry'
import { CLAUDE_CODE_RELEASE_STORE_KEY, CODEX_RELEASE_STORE_KEY, RuntimeReleaseStore } from './release-store'
import { type RuntimeBaseline, RuntimeUpdateController } from './runtime-updates'
import { RuntimeAssetService } from './service'
import { createBundledRuntimeDownloader } from './downloader'

let service: RuntimeAssetService | null = null
const releaseStores = new Map<UpdatableRuntimeAssetId, RuntimeReleaseStore>()
const updateControllers = new Map<UpdatableRuntimeAssetId, RuntimeUpdateController>()
const imageBaselines = new Map<UpdatableRuntimeAssetId, Promise<RuntimeBaseline | null>>()
const runtimeUpdateListeners = new Set<(id: UpdatableRuntimeAssetId) => void>()
const runtimeUpdateListenerTimers = new Map<UpdatableRuntimeAssetId, ReturnType<typeof setTimeout>>()
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
      // Bots keep their runtimes current on their own; the desktop app notifies and lets the user decide.
      automaticDefault: isBotMode(),
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
    onStatusChanged: (status) => {
      scheduleRuntimeAssetChanged(status.id)
      if (isUpdatableRuntimeAssetId(status.id)) notifyRuntimeUpdateListeners(status.id)
    },
  })
  return service
}

/** Bots update on their own unless the server turned it off (`MAESTRLY_GATEWAY_BOT_RUNTIME_UPDATES=off`). */
export function botRuntimeUpdatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FLEET_BOT_ENV.runtimeUpdates] !== 'off'
}

function scheduleRuntimeUpdates(): boolean {
  return !isE2E() && (app.isPackaged || (isBotMode() && botRuntimeUpdatesEnabled()))
}

async function readImageBaseline(id: UpdatableRuntimeAssetId): Promise<RuntimeBaseline | null> {
  switch (id) {
    case 'codex-runtime': {
      try {
        const image = resolveCodexRuntime()
        return image.source === 'materialized' && image.version ? { version: image.version } : null
      } catch {
        return null
      }
    }
    case 'claude-code-runtime': {
      // The binary of the Agent SDK's platform package is the Claude Code the SDK bundles.
      const bundled = bundledClaudeCandidate()
      if (!bundled) return null
      try {
        accessSync(bundled, constants.X_OK)
        return { version: CLAUDE_CODE_PINNED_VERSION }
      } catch {
        return null
      }
    }
  }
}

/**
 * The runtime a bot image ships, which a managed installation must be newer than to be used. Null outside bots and
 * when the image has none. The image never changes while this process runs, so it is read once.
 */
export function imageRuntimeBaseline(id: UpdatableRuntimeAssetId): Promise<RuntimeBaseline | null> {
  if (!isBotMode()) return Promise.resolve(null)
  let baseline = imageBaselines.get(id)
  if (!baseline) {
    baseline = readImageBaseline(id)
    imageBaselines.set(id, baseline)
  }
  return baseline
}

/**
 * Called after an updatable runtime's installation or release channel changed (throttled), so its consumers can
 * switch to the version now in use.
 */
export function onRuntimeUpdateChanged(listener: (id: UpdatableRuntimeAssetId) => void): () => void {
  runtimeUpdateListeners.add(listener)
  return () => runtimeUpdateListeners.delete(listener)
}

function notifyRuntimeUpdateListeners(id: UpdatableRuntimeAssetId): void {
  if (!runtimeUpdateListeners.size || runtimeUpdateListenerTimers.has(id)) return
  const timer = setTimeout(() => {
    runtimeUpdateListenerTimers.delete(id)
    for (const listener of runtimeUpdateListeners) {
      try {
        listener(id)
      } catch {
        // A consumer's failure never affects the update or the other consumers.
      }
    }
  }, RUNTIME_ASSET_NOTIFICATION_THROTTLE_MS)
  timer.unref?.()
  runtimeUpdateListenerTimers.set(id, timer)
}

function runtimeUpdateChanged(id: UpdatableRuntimeAssetId): void {
  scheduleRuntimeAssetChanged(id)
  notifyRuntimeUpdateListeners(id)
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
        onChanged: () => runtimeUpdateChanged('codex-runtime'),
        schedule: scheduleRuntimeUpdates(),
        baseline: () => imageRuntimeBaseline('codex-runtime'),
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
        onChanged: () => runtimeUpdateChanged('claude-code-runtime'),
        schedule: scheduleRuntimeUpdates(),
        baseline: () => imageRuntimeBaseline('claude-code-runtime'),
      })
  }
}

/**
 * Independent release channel of one runtime. Background checks run in packaged builds and in bots (unless the server
 * turned them off), never in development or E2E builds.
 */
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

/** Codex everywhere its schedule allows; Claude Code only in bots, the only place Maestrly manages it. */
export function startRuntimeAssetUpdates(): void {
  codexRuntimeUpdates().start()
  if (isBotMode()) runtimeUpdates('claude-code-runtime').start()
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
  const baseline = isUpdatableRuntimeAssetId(id) ? await imageRuntimeBaseline(id) : null
  const managedNewer =
    status.state === 'ready' &&
    !!status.version &&
    !!baseline &&
    (compareStableVersions(status.version, baseline.version) ?? 0) > 0
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
    ...(baseline ? { provided: { version: baseline.version, active: !managedNewer } } : {}),
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
        /^\.tmp-(?:codex-runtime|claude-code-runtime|github-copilot-runtime|tunnel-client|local-ml-runtime|whisper-model)-/.test(
          entry
        )
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
  imageBaselines.clear()
  runtimeUpdateListeners.clear()
  for (const timer of runtimeUpdateListenerTimers.values()) clearTimeout(timer)
  runtimeUpdateListenerTimers.clear()
  service = null
  diskUsageCache.clear()
}
