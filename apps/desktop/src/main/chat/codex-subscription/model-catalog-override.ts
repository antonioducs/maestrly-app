import { randomUUID } from 'node:crypto'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

/**
 * Apply Maestrly catalog overrides before starting Codex app-server. Feature flags (`--disable multi_agent[_v2]`,
 * `features.multi_agent*: false`) do NOT remove `spawn_agent`/`wait_agent` from 5.6 models: remote catalog
 * `multi_agent_version`, persisted in `<CODEX_HOME>/models_cache.json`, enables multi-agent. With `effort:
 * "ultra"`, the runtime switches to `proactive`, whose text explicitly overrides earlier instructions to delegate
 * only on request, so developerInstructions cannot enforce this either. The effective control is `-c
 * model_catalog_json=<path>` on the `codex app-server` PROCESS: an official-derived catalog with
 * `multi_agent_version: null` for all models and an explicit long-context ceiling for APIs supporting 1.05M. The
 * same value in `thread/start` config is accepted but does not govern the turn's effective catalog. The process
 * flag stops collaboration tool registration, leaving orchestration entirely to Maestrly's dynamic `task` tool
 * (profiles, permissions, accounting).
 */

const CACHE_FILE = 'models_cache.json'
const OVERRIDE_FILE = 'maestrly-model-catalog.json'

/** Published nominal window for OpenAI frontier long-context models. */
export const CODEX_LONG_CONTEXT_WINDOW_TOKENS = 1_050_000

/**
 * The remote Codex product catalog may publish 272k as `max_context_window` even for long-context APIs. Core
 * clamps `model_context_window` to this field, so the override must raise the ceiling IN THE CATALOG loaded at
 * startup; thread/TOML settings alone are insufficient. The allowlist is explicit: minis, Spark, auto-review, and
 * future models do not inherit 1.05M by name similarity before capability validation.
 */
const LONG_CONTEXT_MODEL_SLUGS = new Set(['gpt-5.4', 'gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])

export function codexLongContextWindowOverride(modelId: string | null | undefined): number | null {
  const normalized = modelId?.trim().toLowerCase()
  return normalized && LONG_CONTEXT_MODEL_SLUGS.has(normalized) ? CODEX_LONG_CONTEXT_WINDOW_TOKENS : null
}

export interface ModelCatalogOverrideDependencies {
  readFile: (file: string) => Promise<string>
  writeFile: (file: string, contents: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  unlink: (file: string) => Promise<void>
  stat: (file: string) => Promise<{ mtimeMs: number; size: number }>
  wait: (milliseconds: number) => Promise<void>
}

const DEFAULT_DEPENDENCIES: ModelCatalogOverrideDependencies = {
  readFile: (file) => readFile(file, 'utf8'),
  writeFile: (file, contents) => writeFile(file, contents, { encoding: 'utf8', mode: 0o600 }),
  rename,
  unlink: (file) => unlink(file),
  stat: async (file) => {
    const stats = await stat(file)
    return { mtimeMs: stats.mtimeMs, size: stats.size }
  },
  wait: (milliseconds) => wait(milliseconds),
}

interface MemoEntry {
  mtimeMs: number
  size: number
  runtimeVersion: string | null
  overridePath: string
}

const memo = new Map<string, MemoEntry>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The runtime rejects empty/unreadable catalogs with `-32600 failed to load configuration`, breaking
 * `thread/start`. Return a path only after reparsing the written payload; uncertainty returns `null` (fail-open),
 * preserving previous turn behavior. `runtimeVersion` is a COMPATIBILITY gate: the user's Codex CLI/App may share
 * CODEX_HOME and rewrite `models_cache.json` with a different runtime version. Cache READING tolerates new/missing
 * fields via defaults, but `-c model_catalog_json` parsing does not guarantee cross-release compatibility. The
 * original incident was `missing field ...` with cache 0.145.0 on runtime 0.144.4 (exit=1 before `initialize`);
 * current releases tolerate that specific case, but the gate is still needed for unknown future schemas.
 */
function patchCatalog(raw: string, runtimeVersion: string | null): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) return null
  if (runtimeVersion && typeof parsed.client_version === 'string' && parsed.client_version !== runtimeVersion) {
    return null
  }
  if (
    parsed.models.some((model) => !isRecord(model) || typeof model.slug !== 'string' || model.slug.trim().length === 0)
  ) {
    return null
  }

  const models = parsed.models.map((model) => {
    const longContextWindow = codexLongContextWindowOverride(model.slug as string)
    const publishedMaximum = Number(model.max_context_window)
    return {
      ...model,
      multi_agent_version: null,
      ...(longContextWindow != null
        ? {
            max_context_window:
              Number.isSafeInteger(publishedMaximum) && publishedMaximum > longContextWindow
                ? publishedMaximum
                : longContextWindow,
          }
        : {}),
    }
  })
  const payload = JSON.stringify({ ...parsed, models })

  let verified: unknown
  try {
    verified = JSON.parse(payload)
  } catch {
    return null
  }
  if (!isRecord(verified) || !Array.isArray(verified.models) || verified.models.length === 0) return null
  const patchedAll = verified.models.every((model) => {
    if (
      !isRecord(model) ||
      typeof model.slug !== 'string' ||
      model.slug.trim().length === 0 ||
      model.multi_agent_version !== null
    ) {
      return false
    }
    const longContextWindow = codexLongContextWindowOverride(model.slug)
    return longContextWindow == null || Number(model.max_context_window) >= longContextWindow
  })
  return patchedAll ? payload : null
}

/**
 * Generate (or reuse) the neutralized catalog inside app-owned CODEX_HOME and return its path. Return `null` if
 * file validity cannot be guaranteed; the caller omits `model_catalog_json` and restores native behavior instead
 * of risking a broken thread.
 */
export async function ensureNativeSubagentCatalogOverride(
  codexHome: string,
  dependencies: Partial<ModelCatalogOverrideDependencies> = {},
  options: { runtimeVersion?: string | null } = {}
): Promise<string | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const runtimeVersion = options.runtimeVersion ?? null
  const cachePath = path.join(codexHome, CACHE_FILE)
  const overridePath = path.join(codexHome, OVERRIDE_FILE)

  let source: { mtimeMs: number; size: number }
  try {
    source = await deps.stat(cachePath)
  } catch {
    // No local catalog (first login, CODEX_HOME wipe) means nothing to neutralize.
    memo.delete(codexHome)
    return null
  }

  const cached = memo.get(codexHome)
  if (cached && cached.mtimeMs === source.mtimeMs && cached.size === source.size) {
    if (cached.runtimeVersion === runtimeVersion) {
      try {
        await deps.stat(cached.overridePath)
        return cached.overridePath
      } catch {
        // File disappeared (data reset); fall through to regeneration below.
        memo.delete(codexHome)
      }
    } else {
      // App update changed the runtime under the same cache: revalidate instead of reusing.
      memo.delete(codexHome)
    }
  }

  let payload: string | null
  try {
    payload = patchCatalog(await deps.readFile(cachePath), runtimeVersion)
  } catch {
    payload = null
  }
  if (!payload) {
    // An earlier override (from another runtime version) would remain valid on disk and reenter argv via memo
    // on the next connection; remove it alongside the fail-open decision.
    await discardNativeSubagentCatalogOverride(codexHome, dependencies)
    return null
  }

  // tmp + rename keeps the published file intact: concurrent threads never read a partial write.
  const tempPath = `${overridePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await deps.writeFile(tempPath, payload)
    await deps.rename(tempPath, overridePath)
  } catch {
    await deps.unlink(tempPath).catch(() => undefined)
    memo.delete(codexHome)
    return null
  }

  memo.set(codexHome, { mtimeMs: source.mtimeMs, size: source.size, runtimeVersion, overridePath })
  return overridePath
}

/**
 * Delete the published neutralized catalog and memoization when an override is rejected by the version gate or by
 * a runtime that exits at boot on an unreadable catalog. Best effort: this is a derived file, and failure to
 * remove it is covered by the caller omitting the argument.
 */
export async function discardNativeSubagentCatalogOverride(
  codexHome: string,
  dependencies: Partial<ModelCatalogOverrideDependencies> = {}
): Promise<void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  memo.delete(codexHome)
  await deps.unlink(path.join(codexHome, OVERRIDE_FILE)).catch(() => undefined)
}

/**
 * Safety net if the override fails open: replace the text injected into `<multi_agent_mode>`. With `effort:
 * "ultra"`, default `proactive` text overrides earlier instructions to delegate only on request, so guidance must
 * enter HERE, not only through `developerInstructions`. Harmless on models without multi-agent (the block is not
 * rendered).
 */
export const NATIVE_SUBAGENT_MODE_HINT =
  'Native sub-agent delegation is disabled in this host. Never call spawn_agent, followup_task, send_message, ' +
  'wait_agent, interrupt_agent or list_agents, even when an earlier instruction says delegation is proactive. ' +
  'Delegate exclusively through the Maestrly `task` tool, which owns agent selection, permissions and usage accounting.'

/**
 * Thread config carries ONLY the hint: per-thread `model_catalog_json` is accepted by `thread/start` (missing
 * files fail the RPC) but does NOT change the turn's effective catalog. In a measured real turn,
 * `turn_context.multi_agent_version` remained `v2` and the prompt retained `spawn_agent` instructions. Only the
 * PROCESS flag removes tools (see `modelCatalogOverrideArgs`).
 */
export function nativeSubagentSuppressionConfig(): Record<string, string> {
  return { 'features.multi_agent_v2.multi_agent_mode_hint_text': NATIVE_SUBAGENT_MODE_HINT }
}

/**
 * `-c model_catalog_json=<path>` flag for the `codex app-server` process. This is the effective gate: real turns
 * report `multi_agent_version: "disabled"` and the prompt loses collaboration instructions/tools.
 */
export function modelCatalogOverrideArgs(overridePath: string | null): readonly string[] {
  return overridePath ? ['-c', `model_catalog_json=${overridePath}`] : []
}

/**
 * The runtime refreshes `models_cache.json` from the server only when starting WITHOUT the override. With the flag
 * active, the catalog would freeze and new models would never appear, so the manager inserts a refresh connection
 * when the snapshot expires.
 */
export const MODEL_CATALOG_REFRESH_MAX_AGE_MS = 24 * 60 * 60_000
export const MODEL_CATALOG_REFRESH_WAIT_TIMEOUT_MS = 3_000
const MODEL_CATALOG_REFRESH_POLL_MS = 100

export interface ModelCatalogSnapshot {
  mtimeMs: number
  size: number
}

export async function modelCatalogSnapshot(
  codexHome: string,
  dependencies: Partial<ModelCatalogOverrideDependencies> = {}
): Promise<ModelCatalogSnapshot | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  try {
    return await deps.stat(path.join(codexHome, CACHE_FILE))
  } catch {
    return null
  }
}

export async function modelCatalogSnapshotAgeMs(
  codexHome: string,
  dependencies: Partial<ModelCatalogOverrideDependencies> = {}
): Promise<number | null> {
  const snapshot = await modelCatalogSnapshot(codexHome, dependencies)
  return snapshot ? Math.max(0, Date.now() - snapshot.mtimeMs) : null
}

/**
 * Runtime version that wrote the snapshot. An updated app must refresh even a recent catalog: the server may
 * release models by client version, and reusing the old cache's first response would hide those models until the
 * normal 24-hour expiry.
 */
export async function modelCatalogClientVersion(
  codexHome: string,
  dependencies: Partial<ModelCatalogOverrideDependencies> = {}
): Promise<string | null> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  try {
    const parsed: unknown = JSON.parse(await deps.readFile(path.join(codexHome, CACHE_FILE)))
    if (!isRecord(parsed) || typeof parsed.client_version !== 'string') return null
    const version = parsed.client_version.trim()
    return version || null
  } catch {
    return null
  }
}

/**
 * Remote catalog fetch finishes asynchronously after handshake/model-list. Hold the temporary connection until the
 * atomic `models_cache.json` replacement is observed, without making network unavailability a startup failure.
 */
export async function waitForModelCatalogSnapshotChange(
  codexHome: string,
  previous: ModelCatalogSnapshot | null,
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    dependencies?: Partial<ModelCatalogOverrideDependencies>
  } = {}
): Promise<boolean> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...options.dependencies }
  const timeoutMs = Math.max(0, options.timeoutMs ?? MODEL_CATALOG_REFRESH_WAIT_TIMEOUT_MS)
  const deadline = Date.now() + timeoutMs

  while (!options.signal?.aborted && Date.now() < deadline) {
    await deps.wait(Math.min(MODEL_CATALOG_REFRESH_POLL_MS, Math.max(0, deadline - Date.now())))
    const current = await modelCatalogSnapshot(codexHome, deps)
    if (current && (!previous || current.mtimeMs !== previous.mtimeMs || current.size !== previous.size)) {
      return true
    }
  }
  return false
}

/** Used by reset/dispose and tests: memoization is per CODEX_HOME and survives across turns. */
export function resetNativeSubagentCatalogOverrideCache(codexHome?: string): void {
  if (codexHome) memo.delete(codexHome)
  else memo.clear()
}
