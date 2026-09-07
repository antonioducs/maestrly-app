import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CODEX_LONG_CONTEXT_WINDOW_TOKENS,
  codexLongContextWindowOverride,
  discardNativeSubagentCatalogOverride,
  ensureNativeSubagentCatalogOverride,
  MODEL_CATALOG_REFRESH_MAX_AGE_MS,
  modelCatalogClientVersion,
  modelCatalogOverrideArgs,
  modelCatalogSnapshot,
  modelCatalogSnapshotAgeMs,
  nativeSubagentSuppressionConfig,
  NATIVE_SUBAGENT_MODE_HINT,
  resetNativeSubagentCatalogOverrideCache,
  waitForModelCatalogSnapshotChange,
} from '../../src/main/chat/codex-subscription/model-catalog-override'

const CACHE = 'models_cache.json'
const OVERRIDE = 'maestrly-model-catalog.json'
const CURRENT_RUNTIME_VERSION = '0.153.4'

const catalog = (models: unknown[]): string =>
  JSON.stringify({ fetched_at: '2026-09-04T00:00:00Z', client_version: CURRENT_RUNTIME_VERSION, models })

const realCatalog = catalog([
  {
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    multi_agent_version: 'v2',
    context_window: 272_000,
    max_context_window: 272_000,
  },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', multi_agent_version: 'v1' },
  { slug: 'gpt-5.5', display_name: 'GPT-5.5', multi_agent_version: null },
  { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4 Mini', multi_agent_version: null, max_context_window: 272_000 },
  { slug: 'gpt-5.3-codex-spark', display_name: 'Spark', multi_agent_version: null, max_context_window: 128_000 },
])

describe('Codex native subagent catalog override', () => {
  let codexHome: string

  beforeEach(async () => {
    codexHome = await mkdtemp(path.join(os.tmpdir(), 'maestrly-codex-catalog-'))
    resetNativeSubagentCatalogOverrideCache()
  })

  afterEach(async () => {
    resetNativeSubagentCatalogOverrideCache()
    await rm(codexHome, { recursive: true, force: true })
  })

  it('clears multi_agent_version and publishes 1.05M only for known long-context models', async () => {
    await writeFile(path.join(codexHome, CACHE), realCatalog, 'utf8')

    const overridePath = await ensureNativeSubagentCatalogOverride(codexHome)

    expect(overridePath).toBe(path.join(codexHome, OVERRIDE))
    const written = JSON.parse(await readFile(overridePath!, 'utf8')) as {
      client_version: string
      models: Array<Record<string, unknown>>
    }
    expect(written.client_version).toBe(CURRENT_RUNTIME_VERSION)
    expect(written.models.map((model) => model.multi_agent_version)).toEqual([null, null, null, null, null])
    expect(written.models[0]).toMatchObject({
      slug: 'gpt-5.6-sol',
      display_name: 'GPT-5.6-Sol',
      context_window: 272_000,
      max_context_window: CODEX_LONG_CONTEXT_WINDOW_TOKENS,
    })
    expect(written.models.slice(0, 3).map((model) => model.max_context_window)).toEqual([
      CODEX_LONG_CONTEXT_WINDOW_TOKENS,
      CODEX_LONG_CONTEXT_WINDOW_TOKENS,
      CODEX_LONG_CONTEXT_WINDOW_TOKENS,
    ])
    expect(written.models.slice(3).map((model) => model.max_context_window)).toEqual([272_000, 128_000])
    expect(codexLongContextWindowOverride('GPT-5.6-TERRA')).toBe(CODEX_LONG_CONTEXT_WINDOW_TOKENS)
    expect(codexLongContextWindowOverride('gpt-5.4-mini')).toBeNull()
  })

  it('fails open for missing, invalid or empty cached catalogs', async () => {
    expect(await ensureNativeSubagentCatalogOverride(codexHome)).toBeNull()

    await writeFile(path.join(codexHome, CACHE), '{"models": [', 'utf8')
    expect(await ensureNativeSubagentCatalogOverride(codexHome)).toBeNull()

    await writeFile(path.join(codexHome, CACHE), catalog([]), 'utf8')
    expect(await ensureNativeSubagentCatalogOverride(codexHome)).toBeNull()

    await writeFile(path.join(codexHome, CACHE), JSON.stringify({ models: 'nope' }), 'utf8')
    expect(await ensureNativeSubagentCatalogOverride(codexHome)).toBeNull()

    await writeFile(path.join(codexHome, CACHE), JSON.stringify({ models: [{}] }), 'utf8')
    expect(await ensureNativeSubagentCatalogOverride(codexHome)).toBeNull()

    // No published or temporary files; callers omit model_catalog_json and stay native.
    expect(readdirSync(codexHome)).toEqual([CACHE])
  })

  it('rejects mismatched runtime versions and removes stale overrides', async () => {
    // Reproduce newer CLI cache schema replacing the old cache; the parser
    // strict `-c model_catalog_json` decoding in the pinned runtime killed app-server on boot (exit=1).
    const cachePath = path.join(codexHome, CACHE)
    await writeFile(cachePath, realCatalog, 'utf8')

    const compatible = await ensureNativeSubagentCatalogOverride(
      codexHome,
      {},
      { runtimeVersion: CURRENT_RUNTIME_VERSION }
    )
    expect(compatible).toBe(path.join(codexHome, OVERRIDE))

    await writeFile(cachePath, catalog([{ slug: 'gpt-5.6-sol' }]).replace(CURRENT_RUNTIME_VERSION, '0.154.0'), 'utf8')
    const stats = await stat(cachePath)
    await utimes(cachePath, stats.atime, new Date(stats.mtimeMs + 5_000))

    expect(
      await ensureNativeSubagentCatalogOverride(codexHome, {}, { runtimeVersion: CURRENT_RUNTIME_VERSION })
    ).toBeNull()
    // Remove published files so stale memoization cannot restore their argv override.
    expect(readdirSync(codexHome)).toEqual([CACHE])
  })

  it('allows unknown runtime or cache versions', async () => {
    // Development PATH runtimes without package versions cannot be version-gated.
    await writeFile(
      path.join(codexHome, CACHE),
      realCatalog.replace(`"client_version":"${CURRENT_RUNTIME_VERSION}",`, ''),
      'utf8'
    )
    expect(await ensureNativeSubagentCatalogOverride(codexHome, {}, { runtimeVersion: '0.146.0' })).not.toBeNull()

    resetNativeSubagentCatalogOverrideCache()
    await writeFile(path.join(codexHome, CACHE), realCatalog.replace(CURRENT_RUNTIME_VERSION, '0.154.0'), 'utf8')
    expect(await ensureNativeSubagentCatalogOverride(codexHome)).not.toBeNull()
  })

  it('revalidates catalogs when the runtime changes', async () => {
    await writeFile(path.join(codexHome, CACHE), realCatalog, 'utf8')
    const readSpy = vi.fn(async (file: string) => readFile(file, 'utf8'))

    const first = await ensureNativeSubagentCatalogOverride(
      codexHome,
      { readFile: readSpy },
      { runtimeVersion: CURRENT_RUNTIME_VERSION }
    )
    expect(first).not.toBeNull()

    // Runtime updates can change binaries without changing CODEX_HOME; stale memoization is unsafe.
    const afterUpdate = await ensureNativeSubagentCatalogOverride(
      codexHome,
      { readFile: readSpy },
      { runtimeVersion: '0.150.0' }
    )

    expect(afterUpdate).toBeNull()
    expect(readSpy).toHaveBeenCalledTimes(2)
  })

  it('reads client versions and fails open for invalid caches', async () => {
    expect(await modelCatalogClientVersion(codexHome)).toBeNull()

    await writeFile(path.join(codexHome, CACHE), realCatalog, 'utf8')
    expect(await modelCatalogClientVersion(codexHome)).toBe(CURRENT_RUNTIME_VERSION)

    await writeFile(path.join(codexHome, CACHE), '{', 'utf8')
    expect(await modelCatalogClientVersion(codexHome)).toBeNull()
  })

  it('discards published overrides and memoized state', async () => {
    await writeFile(path.join(codexHome, CACHE), realCatalog, 'utf8')
    const overridePath = await ensureNativeSubagentCatalogOverride(codexHome)
    expect(overridePath).not.toBeNull()

    await discardNativeSubagentCatalogOverride(codexHome)

    expect(readdirSync(codexHome)).toEqual([CACHE])
    // Without memoization, subsequent requests regenerate the override.
    await expect(ensureNativeSubagentCatalogOverride(codexHome)).resolves.toBe(overridePath)
    // Repeated discard without files must remain safe.
    await discardNativeSubagentCatalogOverride(codexHome)
    await expect(discardNativeSubagentCatalogOverride(codexHome)).resolves.toBeUndefined()
  })

  it('fails open on writes without temporary leftovers', async () => {
    await writeFile(path.join(codexHome, CACHE), realCatalog, 'utf8')
    const unlink = vi.fn(async () => {})

    const overridePath = await ensureNativeSubagentCatalogOverride(codexHome, {
      writeFile: async () => {
        throw new Error('disk full')
      },
      unlink,
    })

    expect(overridePath).toBeNull()
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining(`${OVERRIDE}.`))
    expect(readdirSync(codexHome)).toEqual([CACHE])
  })

  it('memoizes by mtime and size and regenerates changed catalogs', async () => {
    const cachePath = path.join(codexHome, CACHE)
    await writeFile(cachePath, realCatalog, 'utf8')
    const readSpy = vi.fn(async (file: string) => readFile(file, 'utf8'))

    const first = await ensureNativeSubagentCatalogOverride(codexHome, { readFile: readSpy })
    const second = await ensureNativeSubagentCatalogOverride(codexHome, { readFile: readSpy })

    expect(second).toBe(first)
    expect(readSpy).toHaveBeenCalledTimes(1)

    await writeFile(cachePath, catalog([{ slug: 'gpt-5.7', multi_agent_version: 'v2' }]), 'utf8')
    const stats = await stat(cachePath)
    await utimes(cachePath, stats.atime, new Date(stats.mtimeMs + 5_000))

    const third = await ensureNativeSubagentCatalogOverride(codexHome, { readFile: readSpy })

    expect(third).toBe(first)
    expect(readSpy).toHaveBeenCalledTimes(2)
    const written = JSON.parse(await readFile(third!, 'utf8')) as { models: Array<Record<string, unknown>> }
    expect(written.models).toEqual([{ slug: 'gpt-5.7', multi_agent_version: null }])
  })

  it('regenerates missing overrides despite intact caches', async () => {
    await writeFile(path.join(codexHome, CACHE), realCatalog, 'utf8')
    const first = await ensureNativeSubagentCatalogOverride(codexHome)
    await rm(first!, { force: true })

    const second = await ensureNativeSubagentCatalogOverride(codexHome)

    expect(second).toBe(first)
    await expect(readFile(second!, 'utf8')).resolves.toContain('"multi_agent_version":null')
  })

  it('keeps catalog flags process-scoped and only hints thread-scoped', async () => {
    // Per-thread catalog settings do not change real turn catalogs and remain omitted.
    expect(nativeSubagentSuppressionConfig()).toEqual({
      'features.multi_agent_v2.multi_agent_mode_hint_text': NATIVE_SUBAGENT_MODE_HINT,
    })
    expect(NATIVE_SUBAGENT_MODE_HINT).toContain('spawn_agent')
    expect(NATIVE_SUBAGENT_MODE_HINT).toContain('`task`')

    expect(modelCatalogOverrideArgs('/tmp/catalog.json')).toEqual(['-c', 'model_catalog_json=/tmp/catalog.json'])
    expect(modelCatalogOverrideArgs(null)).toEqual([])
  })

  it('measures snapshot age and handles missing caches', async () => {
    expect(await modelCatalogSnapshotAgeMs(codexHome)).toBeNull()

    await writeFile(path.join(codexHome, CACHE), realCatalog, 'utf8')
    const fresh = await modelCatalogSnapshotAgeMs(codexHome)
    expect(fresh).toBeGreaterThanOrEqual(0)
    expect(fresh).toBeLessThan(MODEL_CATALOG_REFRESH_MAX_AGE_MS)

    const cachePath = path.join(codexHome, CACHE)
    const stats = await stat(cachePath)
    const old = new Date(stats.mtimeMs - MODEL_CATALOG_REFRESH_MAX_AGE_MS - 60_000)
    await utimes(cachePath, stats.atime, old)
    expect(await modelCatalogSnapshotAgeMs(codexHome)).toBeGreaterThan(MODEL_CATALOG_REFRESH_MAX_AGE_MS)
  })

  it('awaits snapshot replacement before closing refresh connections', async () => {
    const previous = { mtimeMs: 10, size: 100 }
    let reads = 0
    const stat = vi.fn(async () => {
      reads += 1
      return reads < 3 ? previous : { mtimeMs: 20, size: 200 }
    })
    const wait = vi.fn(async () => {})

    await expect(
      waitForModelCatalogSnapshotChange(codexHome, previous, {
        timeoutMs: 1_000,
        dependencies: { stat, wait },
      })
    ).resolves.toBe(true)
    expect(stat).toHaveBeenCalledTimes(3)
    expect(wait).toHaveBeenCalledTimes(3)
  })

  it('abandons refresh waits immediately on connection abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const stat = vi.fn(async () => ({ mtimeMs: 20, size: 200 }))
    const wait = vi.fn(async () => {})

    await expect(
      waitForModelCatalogSnapshotChange(codexHome, await modelCatalogSnapshot(codexHome), {
        signal: controller.signal,
        dependencies: { stat, wait },
      })
    ).resolves.toBe(false)
    expect(stat).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })
})
