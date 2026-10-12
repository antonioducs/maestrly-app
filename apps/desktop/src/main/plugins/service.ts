import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type {
  InstalledPluginDto,
  PluginCatalogEntryDto,
  PluginConsentInput,
  PluginInspectionDto,
  PluginMarketplaceDto,
  PluginOpErrorCode,
  PluginOpResult,
  PluginPolicyDto,
  PluginScope,
  PluginsStateDto,
} from '../../shared/plugins'
import { removeMcpCatalog } from '../chat/mcp-catalog'
import { invalidateMcpRuntime } from '../chat/mcp'
import { forgetMcpOAuth, mcpOAuthStatus } from '../chat/mcp-oauth'
import { sniffImageFormat } from '../chat/image-magic'
import { forgetSkillNames } from '../chat/skill-state'
import { isSecureStorageAvailable } from '../secure-store'
import { appPluginLayout } from './app-layout'
import { classifyPlugin } from './compatibility'
import { launchDigest } from './consent'
import { PluginGitError, PluginGitSource, sparsePattern } from './git-source'
import {
  CATALOG_PATTERNS,
  type Inspection,
  PLUGIN_DETAIL_PATTERNS,
  PLUGIN_METADATA_PATTERNS,
  inputDtos,
  inspectTree,
  manifestReferencedPatterns,
  mcpServerDtos,
  skillDtos,
  toCatalogEntryDto,
  toInspectionDto,
} from './inspect'
import {
  type InstallerDeps,
  type PreparedInstall,
  installPrepared,
  reconcilePlugins,
  uninstallPlugin,
  updatePrepared,
} from './installer'
import { PLUGIN_LIMITS } from './limits'
import type { MarketplaceEntry, ParsedMarketplace } from './marketplace'
import { readMarketplace } from './marketplace'
import { type PackageTree, type TreeEntry, gitPackageTree } from './package-tree'
import { invalidatePluginRuntimeCache, listPluginMcpServers, loadInstalledPackage } from './runtime'
import {
  type InstalledPluginRecord,
  type MarketplaceRecord,
  getMarketplace,
  listInstalled,
  listMarketplaces,
  marketplaceId,
  readPluginSecrets,
  removeMarketplaceRecord,
  saveMarketplace,
  writeInstalled,
  writePluginSecrets,
} from './store'

/**
 * Plugin center operations of this host. Every mutation runs through one promise chain, so two installs or a refresh
 * and an install never interleave on the same checkouts or records.
 */

const DEFAULT_POLICY: PluginPolicyDto = { installation: 'AVAILABLE', authentication: null, products: [] }
const GIT_VERSION_TTL_MS = 60_000

let gitSource: PluginGitSource | null = null
const git = (): PluginGitSource => {
  gitSource ??= new PluginGitSource()
  return gitSource
}
/** Tests point Git at a fixture root. */
export function setPluginGitSourceForTests(source: PluginGitSource | null): void {
  gitSource = source
  gitVersionCache = null
}

let chain: Promise<unknown> = Promise.resolve()
function withPluginMutation<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

interface CatalogData {
  commit: string
  market: ParsedMarketplace
  entries: TreeEntry[]
  inspections: Map<string, Inspection>
}
const catalogs = new Map<string, CatalogData>()
const externalInspections = new Map<string, { commit: string; inspection: Inspection; path: string | null }>()

function fail(error: PluginOpErrorCode, detail?: string): { ok: false; error: PluginOpErrorCode; detail?: string } {
  return { ok: false, error, ...(detail ? { detail } : {}) }
}

function failure(error: unknown): { ok: false; error: PluginOpErrorCode; detail?: string } {
  if (error instanceof PluginGitError) return fail(error.code)
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'secure-storage-unavailable') return fail('secure-storage-unavailable')
  if (message === 'path-unsafe') return fail('path-unsafe')
  if (message.startsWith('limit-exceeded')) return fail('limit-exceeded', message)
  return fail('install-failed', message)
}

function installerDeps(): InstallerDeps {
  return {
    layout: appPluginLayout(),
    now: () => Date.now(),
    invalidateServer: (id) => {
      invalidateMcpRuntime(id)
      removeMcpCatalog(id)
    },
    forgetServer: (id) => forgetMcpOAuth(id),
    onSkillsRemoved: (names) => forgetSkillNames(names),
  }
}

/** A key part safe for `name@marketplace` (letters, digits, dots, dashes, underscores). */
function keyPart(value: string): string {
  return (
    value
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[^A-Za-z0-9]+/, '')
      .slice(0, 128) || 'marketplace'
  )
}
export const pluginKey = (name: string, marketplaceName: string): string => `${name}@${keyPart(marketplaceName)}`

function repoSlug(url: string): string {
  const match = /([^/]+?)(?:\.git)?\/?$/.exec(url)
  return keyPart(match?.[1] ?? 'source')
}

function marketplaceDto(record: MarketplaceRecord): PluginMarketplaceDto {
  return {
    id: record.id,
    url: record.url,
    ref: record.ref,
    sparsePaths: record.sparsePaths,
    preset: record.preset,
    name: record.name,
    displayName: record.displayName,
    commit: record.commit,
    fetchedAt: record.fetchedAt,
    error: record.error,
    pluginCount: record.pluginCount,
  }
}

const acceptUrl = (url: string): string | null => {
  try {
    return git().checkUrl(url)
  } catch {
    return null
  }
}

const rebase = (entries: readonly TreeEntry[], prefix: string): TreeEntry[] =>
  prefix
    ? entries
        .filter((entry) => entry.path.startsWith(`${prefix}/`))
        .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length + 1) }))
    : [...entries]

/** Sparse patterns for everything Maestrly reads to list and classify the plugins at `paths`. */
async function materializeForInspection(
  dir: string,
  commit: string,
  entries: TreeEntry[],
  base: string[],
  paths: string[]
): Promise<PackageTree> {
  const patterns = new Set(base)
  for (const p of paths)
    for (const pattern of [...PLUGIN_METADATA_PATTERNS(p), ...PLUGIN_DETAIL_PATTERNS(p)]) patterns.add(pattern)
  await git().checkout(dir, commit, [...patterns])
  const tree = gitPackageTree(dir, entries)
  const before = patterns.size
  for (const p of paths) for (const pattern of await manifestReferencedPatterns(tree, p)) patterns.add(pattern)
  if (patterns.size !== before) await git().checkout(dir, commit, [...patterns])
  return tree
}

async function buildCatalog(record: MarketplaceRecord, fetch: boolean): Promise<CatalogData> {
  const dir = appPluginLayout().source(record.id)
  const commit =
    fetch || !record.commit ? await git().fetch(dir, { url: record.url, ref: record.ref, sha: null }) : record.commit
  const data = await catalogAtCommit(record, commit)
  catalogs.set(record.id, data)
  return data
}

/** The catalog of a source at one commit already fetched into its checkout; nothing is cached or recorded. */
async function catalogAtCommit(record: MarketplaceRecord, commit: string): Promise<CatalogData> {
  const dir = appPluginLayout().source(record.id)
  const entries = await git().listTree(dir, commit)
  const roots = record.sparsePaths.length ? record.sparsePaths : ['']
  const catalogPatterns = roots.flatMap(CATALOG_PATTERNS)
  await git().checkout(dir, commit, catalogPatterns)
  const market = await readMarketplace(gitPackageTree(dir, entries), roots, {
    acceptUrl,
    fallbackName: repoSlug(record.url),
  })
  if (!market) throw new PluginGitError('no-marketplace')
  const local = market.entries.filter((entry) => entry.source.kind === 'path')
  const tree = await materializeForInspection(
    dir,
    commit,
    entries,
    catalogPatterns,
    local.map((entry) => (entry.source.kind === 'path' ? entry.source.path : ''))
  )
  const inspections = new Map<string, Inspection>()
  for (const entry of local) {
    if (entry.source.kind !== 'path') continue
    inspections.set(entry.name, await inspectTree(tree.sub(entry.source.path), entry))
  }
  for (const entry of market.entries)
    if (entry.source.kind === 'unsupported') inspections.set(entry.name, await inspectTree(tree.sub('\0'), entry))
  return { commit, market, entries, inspections }
}

async function catalogData(record: MarketplaceRecord): Promise<CatalogData> {
  const cached = catalogs.get(record.id)
  if (cached && cached.commit === record.commit) return cached
  return buildCatalog(record, !record.commit)
}

/** Marks installed plugins of a marketplace that have a different tree at the marketplace's new commit. */
async function markUpdates(record: MarketplaceRecord, data: CatalogData): Promise<void> {
  const dir = appPluginLayout().source(record.id)
  const installed = Object.values(listInstalled()).filter((item) => item.marketplaceId === record.id)
  const available: Record<string, InstalledPluginRecord['available']> = {}
  for (const item of installed) {
    const entry = data.market.entries.find((candidate) => candidate.name === item.name)
    if (!entry) continue
    try {
      let commit = data.commit
      let treeOid: string | null = null
      if (entry.source.kind === 'path') treeOid = await git().treeOid(dir, data.commit, entry.source.path)
      else if (entry.source.kind === 'git') {
        const ext = await fetchExternal(entry)
        commit = ext.commit
        treeOid = await git().treeOid(ext.dir, ext.commit, entry.source.path ?? '')
      }
      if (treeOid) available[item.key] = { commit, treeOid, checkedAt: Date.now() }
    } catch {
      // A source that cannot be checked keeps its previous update state.
    }
  }
  if (!Object.keys(available).length) return
  writeInstalled((all) => {
    for (const [key, value] of Object.entries(available)) if (all[key]) all[key].available = value
  })
}

function externalDir(entry: MarketplaceEntry): string {
  const source = entry.source.kind === 'git' ? entry.source : null
  const hash = createHash('sha256')
    .update(JSON.stringify([source?.url, source?.ref, source?.sha]))
    .digest('hex')
    .slice(0, 16)
  return appPluginLayout().extSource(hash)
}

async function fetchExternal(entry: MarketplaceEntry): Promise<{ dir: string; commit: string }> {
  if (entry.source.kind !== 'git') throw new PluginGitError('invalid-url')
  const dir = externalDir(entry)
  const commit = await git().fetch(dir, { url: entry.source.url, ref: entry.source.ref, sha: entry.source.sha })
  return { dir, commit }
}

async function inspectExternal(entry: MarketplaceEntry): Promise<{ commit: string; inspection: Inspection }> {
  if (entry.source.kind !== 'git') throw new PluginGitError('invalid-url')
  const { dir, commit } = await fetchExternal(entry)
  const subPath = entry.source.path ?? ''
  const cacheKey = `${dir}\0${commit}\0${subPath}`
  const cached = externalInspections.get(cacheKey)
  if (cached) return cached
  const entries = await git().listTree(dir, commit)
  const tree = await materializeForInspection(dir, commit, entries, [], [subPath])
  const result = { commit, inspection: await inspectTree(tree.sub(subPath), entry), path: entry.source.path }
  externalInspections.set(cacheKey, result)
  return result
}

function findMarketplace(id: string): MarketplaceRecord | null {
  return getMarketplace(id) ?? null
}

// ---------------------------------------------------------------- state

let gitVersionCache: { at: number; version: string | null } | null = null
async function gitVersion(): Promise<string | null> {
  if (gitVersionCache && Date.now() - gitVersionCache.at < GIT_VERSION_TTL_MS) return gitVersionCache.version
  const version = await git().gitVersion()
  gitVersionCache = { at: Date.now(), version }
  return version
}

export async function installedDto(record: InstalledPluginRecord): Promise<InstalledPluginDto> {
  const pkg = await loadInstalledPackage(record)
  const stored = new Set(Object.keys(readPluginSecrets(record.key) ?? {}))
  const inputs = record.inputs ?? []
  const compatibility = pkg
    ? classifyPlugin({ ok: true, pkg }, { sourceSupported: true, installation: record.policy?.installation })
    : {
        level: 'unavailable' as const,
        reasons: [{ code: 'manifest-invalid' as const, detail: 'installed files are missing' }],
      }
  const missingInputs = inputs.filter((input) => input.required && !stored.has(input.id) && input.defaultValue === null)
  const stdioNeedingConsent = (record.mcpServers ?? []).filter(
    (server) => server.transport === 'stdio' && record.consent.stdio[server.key] !== launchDigest(server)
  )
  // Sign-in status of the plugin's remote servers, from their expanded URLs on this host.
  const runtime = new Map(
    listPluginMcpServers({ conversationId: undefined }, { includeInactive: true })
      .filter((server) => server.origin?.pluginKey === record.key)
      .map((server) => [server.origin!.serverKey, server])
  )
  const authStatus = (serverKey: string) => {
    const server = runtime.get(serverKey)
    return server && !server.unavailable ? mcpOAuthStatus(server, !!server.oauth) : 'none'
  }
  const serversNeedingAuth = (record.mcpServers ?? []).filter(
    (server) => record.servers[server.key]?.enabled && authStatus(server.key) === 'needs-auth'
  )
  return {
    key: record.key,
    name: record.name,
    displayName: record.displayName ?? pkg?.displayName ?? record.name,
    marketplaceId: record.marketplaceId,
    version: record.version,
    commit: record.commit,
    enabled: record.enabled,
    scope: record.scope,
    compatibility,
    updateAvailable: !!record.available && record.available.treeOid !== record.treeOid,
    setup: {
      missingInputs: missingInputs.map((input) => input.id),
      stdioNeedingConsent: stdioNeedingConsent.map((server) => server.key),
      serversNeedingAuth: serversNeedingAuth.map((server) => server.key),
    },
    skills: pkg ? skillDtos(pkg) : [],
    mcpServers: pkg
      ? mcpServerDtos(pkg, record, (server) =>
          server.transport === 'stdio' ? {} : { authStatus: authStatus(server.key) }
        )
      : [],
    inputs: inputDtos(inputs, stored),
    policy: record.policy ?? DEFAULT_POLICY,
    installedAt: record.installedAt,
    updatedAt: record.updatedAt,
  }
}

export async function pluginsState(): Promise<PluginsStateDto> {
  const version = await gitVersion()
  const records = Object.values(listInstalled())
    .filter((record) => record.status === 'ready')
    .sort((a, b) => a.key.localeCompare(b.key))
  return {
    git: { available: version !== null, version },
    secureStorage: isSecureStorageAvailable(),
    marketplaces: listMarketplaces().map(marketplaceDto),
    installed: await Promise.all(records.map(installedDto)),
  }
}

// ---------------------------------------------------------------- marketplaces

export function addMarketplace(input: {
  url: string
  ref?: string | null
  sparsePaths?: string[]
}): Promise<PluginOpResult<PluginMarketplaceDto>> {
  return withPluginMutation(() => addMarketplaceUnlocked(input))
}

/** Adds (or refreshes) a source; callers hold the plugin mutation lock. */
async function addMarketplaceUnlocked(input: {
  url: string
  ref?: string | null
  sparsePaths?: string[]
}): Promise<PluginOpResult<PluginMarketplaceDto>> {
  {
    let url: string
    try {
      url = git().checkUrl(input.url)
    } catch {
      return fail('invalid-url')
    }
    const ref = input.ref?.trim() || null
    const sparsePaths = [
      ...new Set((input.sparsePaths ?? []).map((p) => p.replace(/^\.?\/+|\/+$/g, '')).filter(Boolean)),
    ]
    const id = marketplaceId(url, ref, sparsePaths)
    const existing = getMarketplace(id)
    const record: MarketplaceRecord = existing ?? {
      id,
      url,
      ref,
      sparsePaths,
      preset: null,
      name: null,
      displayName: null,
      format: null,
      commit: null,
      fetchedAt: null,
      error: null,
      pluginCount: null,
      addedAt: Date.now(),
    }
    const refreshed = await refreshRecord(record)
    if (!refreshed.ok && !existing) {
      removeMarketplaceRecord(id)
      await fsp.rm(appPluginLayout().source(id), { recursive: true, force: true }).catch(() => undefined)
    }
    return refreshed
  }
}

async function refreshRecord(record: MarketplaceRecord): Promise<PluginOpResult<PluginMarketplaceDto>> {
  try {
    const data = await buildCatalog(record, true)
    const next: MarketplaceRecord = {
      ...record,
      name: data.market.name,
      displayName: data.market.displayName,
      format: data.market.format,
      commit: data.commit,
      fetchedAt: Date.now(),
      error: null,
      pluginCount: data.market.entries.length,
    }
    saveMarketplace(next)
    await markUpdates(next, data)
    return { ok: true, value: marketplaceDto(next) }
  } catch (error) {
    const code = error instanceof PluginGitError ? error.code : 'invalid-repository'
    saveMarketplace({ ...record, error: code, fetchedAt: Date.now() })
    return fail(code)
  }
}

export function refreshMarketplace(id: string): Promise<PluginOpResult<PluginMarketplaceDto>> {
  return withPluginMutation(async () => {
    const record = findMarketplace(id)
    if (!record) return fail('unknown-marketplace')
    externalInspections.clear()
    return refreshRecord(record)
  })
}

export function removeMarketplace(input: { id: string; uninstall: boolean }): Promise<PluginOpResult> {
  return withPluginMutation(async () => {
    const record = findMarketplace(input.id)
    if (!record) return fail('unknown-marketplace')
    const installed = Object.values(listInstalled()).filter((item) => item.marketplaceId === input.id)
    if (installed.length && !input.uninstall) return fail('busy', `${installed.length} installed plugins`)
    for (const item of installed) {
      const result = await uninstallPlugin(item.key, { deleteData: false }, installerDeps())
      if (!result.ok) return result
    }
    removeMarketplaceRecord(input.id)
    catalogs.delete(input.id)
    await fsp.rm(appPluginLayout().source(input.id), { recursive: true, force: true }).catch(() => undefined)
    invalidatePluginRuntimeCache()
    return { ok: true, value: undefined }
  })
}

// ---------------------------------------------------------------- catalog and details

export function catalog(id: string): Promise<PluginOpResult<PluginCatalogEntryDto[]>> {
  return withPluginMutation(async () => {
    const record = findMarketplace(id)
    if (!record) return fail('unknown-marketplace')
    try {
      const data = await catalogData(record)
      if (!record.commit) {
        saveMarketplace({
          ...record,
          name: data.market.name,
          displayName: data.market.displayName,
          format: data.market.format,
          commit: data.commit,
          fetchedAt: Date.now(),
          error: null,
          pluginCount: data.market.entries.length,
        })
      }
      const installed = listInstalled()
      return {
        ok: true,
        value: data.market.entries.map((entry) => {
          const key = pluginKey(entry.name, data.market.name)
          const item = installed[key]
          return toCatalogEntryDto({
            marketplaceId: id,
            entry,
            inspection: data.inspections.get(entry.name) ?? null,
            installed: !!item,
            updateAvailable: !!item?.available && item.available.treeOid !== item.treeOid,
          })
        }),
      }
    } catch (error) {
      return failure(error)
    }
  })
}

async function entryInspection(
  record: MarketplaceRecord,
  name: string,
  at?: { data?: CatalogData; externalSha?: string }
): Promise<
  | {
      ok: true
      data: CatalogData
      entry: MarketplaceEntry
      inspection: Inspection
      commit: string
      url: string
      path: string | null
    }
  | { ok: false; error: PluginOpErrorCode; detail?: string }
> {
  const data = at?.data ?? (await catalogData(record))
  const listed = data.market.entries.find((candidate) => candidate.name === name)
  if (!listed) return fail('unknown-plugin')
  // A pinned external plugin is read at that commit of its own repository.
  const entry: MarketplaceEntry =
    listed.source.kind === 'git' && at?.externalSha
      ? { ...listed, source: { ...listed.source, sha: at.externalSha } }
      : listed
  if (entry.source.kind === 'git') {
    const external = await inspectExternal(entry)
    return {
      ok: true,
      data,
      entry,
      inspection: external.inspection,
      commit: external.commit,
      url: entry.source.url,
      path: entry.source.path,
    }
  }
  const inspection = data.inspections.get(name)
  if (!inspection) return fail('unknown-plugin')
  return {
    ok: true,
    data,
    entry,
    inspection,
    commit: data.commit,
    url: record.url,
    path: entry.source.kind === 'path' ? entry.source.path || null : null,
  }
}

export function inspect(input: { marketplaceId: string; name: string }): Promise<PluginOpResult<PluginInspectionDto>> {
  return withPluginMutation(async () => {
    const record = findMarketplace(input.marketplaceId)
    if (!record) return fail('unknown-marketplace')
    try {
      const found = await entryInspection(record, input.name)
      if (!found.ok) return found
      const key = pluginKey(input.name, found.data.market.name)
      const installed = listInstalled()[key]
      return {
        ok: true,
        value: toInspectionDto({
          marketplaceId: record.id,
          entry: found.entry,
          inspection: found.inspection,
          source: { url: found.url, path: found.path, commit: found.commit },
          ...(installed ? { installed } : {}),
          inputsSet: new Set(Object.keys(readPluginSecrets(key) ?? {})),
          updateAvailable: !!installed?.available && installed.available.treeOid !== installed.treeOid,
        }),
      }
    } catch (error) {
      return failure(error)
    }
  })
}

export function logo(input: { marketplaceId: string; name: string }): Promise<string | null> {
  return withPluginMutation(async () => {
    const record = findMarketplace(input.marketplaceId)
    if (!record) return null
    try {
      const data = await catalogData(record)
      const entry = data.market.entries.find((candidate) => candidate.name === input.name)
      const pkg = data.inspections.get(input.name)?.pkg
      if (!entry || entry.source.kind !== 'path' || !pkg?.logoPath) return null
      const tree = gitPackageTree(appPluginLayout().source(record.id), data.entries).sub(entry.source.path)
      const raw = await tree.read(pkg.logoPath, PLUGIN_LIMITS.logoBytes)
      const format = raw ? sniffImageFormat(raw) : null
      if (!raw || !format || !['image/png', 'image/jpeg', 'image/webp'].includes(format.mime)) return null
      return `data:${format.mime};base64,${raw.toString('base64')}`
    } catch {
      return null
    }
  })
}

// ---------------------------------------------------------------- install and update

async function prepare(
  record: MarketplaceRecord,
  found: Extract<Awaited<ReturnType<typeof entryInspection>>, { ok: true }>
): Promise<PreparedInstall> {
  const { entry, data } = found
  let dir: string
  let commit: string
  let subPath: string
  let source: InstalledPluginRecord['source']
  if (entry.source.kind === 'git') {
    const external = await fetchExternal(entry)
    dir = external.dir
    commit = external.commit
    subPath = entry.source.path ?? ''
    source = { kind: 'git', url: entry.source.url, ref: entry.source.ref, path: entry.source.path }
  } else if (entry.source.kind === 'path') {
    dir = appPluginLayout().source(record.id)
    commit = data.commit
    subPath = entry.source.path
    source = { kind: 'marketplace', path: entry.source.path }
  } else throw new Error('unavailable')
  const all = await git().listTree(dir, commit)
  const roots = record.sparsePaths.length ? record.sparsePaths : ['']
  await git().checkout(dir, commit, [...roots.flatMap(CATALOG_PATTERNS), subPath ? `${sparsePattern(subPath)}/` : '/*'])
  const tree = gitPackageTree(dir, all).sub(subPath)
  const inspection = await inspectTree(tree, entry)
  const treeOid = (await git().treeOid(dir, commit, subPath)) ?? ''
  return {
    key: pluginKey(entry.name, data.market.name),
    name: entry.name,
    marketplaceId: record.id,
    source,
    commit,
    treeOid,
    checkoutDir: subPath ? path.join(dir, ...subPath.split('/')) : dir,
    entries: rebase(all, subPath),
    inspection,
    loadOptions: {
      ...(entry.claude ? { claudeEntry: entry.claude } : {}),
      displayOverrides: { displayName: entry.display.displayName, description: entry.display.description },
      rootName: subPath.split('/').pop() || entry.name,
    },
    policy: entry.policy,
  }
}

interface InstallInput {
  consent: PluginConsentInput
  scope: PluginScope
  inputs?: Record<string, string>
}

export function install(
  input: { marketplaceId: string; name: string } & InstallInput
): Promise<PluginOpResult<InstalledPluginDto>> {
  return withPluginMutation(async () => {
    const record = findMarketplace(input.marketplaceId)
    if (!record) return fail('unknown-marketplace')
    try {
      const result = await installFound(record, await entryInspection(record, input.name), input)
      return result.ok ? { ok: true, value: await installedDto(result.value) } : result
    } catch (error) {
      return failure(error)
    }
  })
}

async function installFound(
  record: MarketplaceRecord,
  found: Awaited<ReturnType<typeof entryInspection>>,
  input: InstallInput
): Promise<PluginOpResult<InstalledPluginRecord>> {
  if (!found.ok) return found
  if (found.entry.source.kind === 'unsupported' || found.entry.policy.installation === 'NOT_AVAILABLE')
    return fail('unavailable')
  const prepared = await prepare(record, found)
  const result = await installPrepared(
    prepared,
    { consent: input.consent, scope: input.scope, inputs: input.inputs },
    installerDeps()
  )
  invalidatePluginRuntimeCache()
  return result
}

/**
 * Installs a plugin that another host has, at that host's exact commit and from the same source (a bot environment
 * bringing a plugin from its owner's computer). The source is added here if needed; the plugin is read at `commit`
 * (of the source, or of its own repository for an external plugin), so the consent given there for that commit
 * matches only an identical version. Scope is every conversation: the other host's projects do not exist here.
 */
export function installPinned(input: {
  source: { url: string; ref?: string | null; sparsePaths?: string[] }
  name: string
  commit: string
  consent: PluginConsentInput
  enabled: boolean
  inputs?: Record<string, string>
}): Promise<PluginOpResult<InstalledPluginDto>> {
  return withPluginMutation(async () => {
    const added = await addMarketplaceUnlocked(input.source)
    if (!added.ok) return added
    const record = findMarketplace(added.value.id)
    if (!record) return fail('unknown-marketplace')
    try {
      const current = await catalogData(record)
      const listed = current.market.entries.find((entry) => entry.name === input.name)
      let found: Awaited<ReturnType<typeof entryInspection>>
      if (listed?.source.kind === 'git')
        found = await entryInspection(record, input.name, { externalSha: input.commit })
      else if (record.commit === input.commit) found = await entryInspection(record, input.name)
      else {
        await git().fetch(appPluginLayout().source(record.id), { url: record.url, ref: record.ref, sha: input.commit })
        found = await entryInspection(record, input.name, { data: await catalogAtCommit(record, input.commit) })
      }
      const installed = await installFound(record, found, {
        consent: input.consent,
        scope: { kind: 'global' },
        inputs: input.inputs,
      })
      if (!installed.ok) return installed
      if (!input.enabled) {
        writeInstalled((all) => {
          if (all[installed.value.key]) all[installed.value.key].enabled = false
        })
        invalidatePluginRuntimeCache()
      }
      return { ok: true, value: await installedDto(listInstalled()[installed.value.key] ?? installed.value) }
    } catch (error) {
      return failure(error)
    }
  })
}

export function update(input: {
  key: string
  consent?: PluginConsentInput
}): Promise<PluginOpResult<InstalledPluginDto>> {
  return withPluginMutation(async () => {
    const installed = listInstalled()[input.key]
    if (!installed) return fail('unknown-plugin')
    const record = findMarketplace(installed.marketplaceId)
    if (!record) return fail('unknown-marketplace')
    try {
      const found = await entryInspection(record, installed.name)
      if (!found.ok) return found
      const prepared = await prepare(record, found)
      const result = await updatePrepared(input.key, prepared, input.consent, installerDeps())
      invalidatePluginRuntimeCache()
      if (!result.ok) return result
      return { ok: true, value: await installedDto(result.value) }
    } catch (error) {
      return failure(error)
    }
  })
}

// ---------------------------------------------------------------- installed settings

/** Applies a change to one ready record; a failed check writes nothing. Callers hold the plugin mutation lock. */
function updateRecord(key: string, change: (record: InstalledPluginRecord) => PluginOpResult | void): PluginOpResult {
  const current = listInstalled()[key]
  if (!current || current.status !== 'ready') return fail('unknown-plugin')
  const draft: InstalledPluginRecord = structuredClone(current)
  const result = change(draft)
  if (result && !result.ok) return result
  draft.updatedAt = Date.now()
  writeInstalled((all) => {
    all[key] = draft
  })
  return { ok: true, value: undefined }
}

function invalidateServers(record: InstalledPluginRecord): void {
  for (const server of Object.values(record.servers)) invalidateMcpRuntime(server.id)
}

export function setEnabled(input: { key: string; enabled: boolean }): Promise<PluginOpResult> {
  return withPluginMutation(async () => {
    const result = updateRecord(input.key, (record) => {
      record.enabled = input.enabled
    })
    const record = listInstalled()[input.key]
    if (record) invalidateServers(record)
    return result
  })
}

export function setScope(input: { key: string; scope: PluginScope }): Promise<PluginOpResult> {
  return withPluginMutation(async () =>
    updateRecord(input.key, (record) => {
      record.scope =
        input.scope.kind === 'global'
          ? { kind: 'global' }
          : { kind: 'projects', workspaceIds: [...new Set(input.scope.workspaceIds)] }
    })
  )
}

export function setServer(input: {
  key: string
  serverKey: string
  enabled: boolean
  consent?: boolean
}): Promise<PluginOpResult> {
  return withPluginMutation(async () => {
    const result = updateRecord(input.key, (record) => {
      const state = record.servers[input.serverKey]
      const spec = (record.mcpServers ?? []).find((server) => server.key === input.serverKey)
      if (!state || !spec) return fail('unknown-plugin', input.serverKey)
      if (spec.auth.kind === 'unusable' && input.enabled) return fail('unavailable')
      if (spec.transport === 'stdio' && input.enabled) {
        const digest = launchDigest(spec)
        if (record.consent.stdio[spec.key] !== digest) {
          if (input.consent !== true) return fail('consent-required')
          record.consent.stdio[spec.key] = digest
        }
      }
      state.enabled = input.enabled
    })
    const record = listInstalled()[input.key]
    if (record?.servers[input.serverKey]) invalidateMcpRuntime(record.servers[input.serverKey].id)
    return result
  })
}

export function setInputs(input: { key: string; values: Record<string, string | null> }): Promise<PluginOpResult> {
  return withPluginMutation(async () => {
    const record = listInstalled()[input.key]
    if (!record || record.status !== 'ready') return fail('unknown-plugin')
    const known = new Set((record.inputs ?? []).map((item) => item.id))
    for (const id of Object.keys(input.values)) if (!known.has(id)) return fail('invalid-input', id)
    const current = readPluginSecrets(input.key)
    const next: Record<string, string> = { ...(current ?? {}) }
    for (const [id, value] of Object.entries(input.values)) {
      if (value === null || value === '') delete next[id]
      else next[id] = value
    }
    try {
      writePluginSecrets(input.key, next)
    } catch (error) {
      return failure(error)
    }
    invalidateServers(record)
    return { ok: true, value: undefined }
  })
}

export function uninstall(input: { key: string; deleteData: boolean }): Promise<PluginOpResult> {
  return withPluginMutation(async () => {
    const result = await uninstallPlugin(input.key, { deleteData: input.deleteData }, installerDeps())
    invalidatePluginRuntimeCache()
    return result
  })
}

/** Finishes or rolls back operations a previous run left in flight, then drops unreferenced directories. */
export async function reconcilePluginsOnStartup(): Promise<void> {
  try {
    await withPluginMutation(() => reconcilePlugins(installerDeps()))
  } catch (error) {
    console.warn('[plugins] startup reconciliation failed:', error instanceof Error ? error.message : error)
  }
}

/** Test seam: forget cached catalogs. */
export function resetPluginServiceCachesForTests(): void {
  catalogs.clear()
  externalInspections.clear()
  gitVersionCache = null
}
