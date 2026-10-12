import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { normalizeSkillName } from '../../shared/chat'
import type { PluginConsentInput, PluginOpErrorCode, PluginOpResult, PluginScope } from '../../shared/plugins'
import { launchDigest } from './consent'
import type { Inspection } from './inspect'
import type { PluginLayout } from './layout'
import { pluginKeyHash } from './layout'
import { PLUGIN_LIMITS } from './limits'
import type { TreeEntry } from './package-tree'
import { assertRealpathInside, isSafeTreePath, resolveInsideRoot } from './paths'
import {
  type InstalledPluginRecord,
  listInstalled,
  pluginServerId,
  readPluginSecrets,
  removePluginSecrets,
  writeInstalled,
  writePluginSecrets,
} from './store'
import type { PluginPackage } from './types'

/**
 * Installs immutable plugin versions under `<plugins>/packages/<keyHash>/<digest12>`. Every write goes through a
 * staging directory on the same volume and a rename, and every record change is one transaction, so a crash leaves
 * either the old or the new version (`reconcilePlugins` finishes or rolls back what was in flight).
 */

export interface InstallerDeps {
  layout: PluginLayout
  now: () => number
  /** Retires pooled connections and the cached tool catalog of a server. Called on every update too. */
  invalidateServer: (id: string) => void
  /** Drops what a server leaves behind once it is gone for good: its OAuth sign-in. */
  forgetServer: (id: string) => void
  /** Removes skill names from global disable lists and groups. */
  onSkillsRemoved: (names: string[]) => void
}

export interface CopyResult {
  digest: string
  files: number
  bytes: number
  skipped: { path: string; reason: 'symlink-skipped' | 'submodule-skipped' }[]
}

export interface PreparedInstall {
  key: string
  name: string
  marketplaceId: string
  source: InstalledPluginRecord['source']
  commit: string
  treeOid: string
  /** Absolute plugin root inside the checkout. */
  checkoutDir: string
  /** Entries re-based to the plugin root. */
  entries: TreeEntry[]
  inspection: Inspection
  loadOptions?: InstalledPluginRecord['loadOptions']
  policy?: InstalledPluginRecord['policy']
}

class InstallError extends Error {
  constructor(
    readonly code: PluginOpErrorCode,
    detail?: string
  ) {
    super(detail ?? code)
  }
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

function errorResult(error: unknown): { ok: false; error: PluginOpErrorCode; detail?: string } {
  if (error instanceof InstallError) return { ok: false, error: error.code, detail: error.message }
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('limit-exceeded')) return { ok: false, error: 'limit-exceeded', detail: message }
  if (message === 'path-unsafe') return { ok: false, error: 'path-unsafe' }
  if (message === 'secure-storage-unavailable') return { ok: false, error: 'secure-storage-unavailable' }
  return { ok: false, error: 'install-failed', detail: message }
}

/** Validates every entry first (paths, counts), then copies regular files with `wx` writes and fixed modes. */
export async function copyPluginTree(srcDir: string, entries: readonly TreeEntry[], dest: string): Promise<CopyResult> {
  const skipped: CopyResult['skipped'] = []
  const files: TreeEntry[] = []
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isSafeTreePath(entry.path)) throw new Error('path-unsafe')
    if (entry.mode === 'symlink' || entry.mode === 'submodule') {
      skipped.push({ path: entry.path, reason: entry.mode === 'symlink' ? 'symlink-skipped' : 'submodule-skipped' })
      continue
    }
    if (entry.path.length > PLUGIN_LIMITS.pathChars) throw new Error('limit-exceeded:path')
    if (entry.path.split('/').length > PLUGIN_LIMITS.depth) throw new Error('limit-exceeded:depth')
    files.push(entry)
  }
  if (files.length > PLUGIN_LIMITS.files) throw new Error('limit-exceeded:files')
  const lines: string[] = []
  let bytes = 0
  await fsp.mkdir(dest, { recursive: true })
  for (const entry of files) {
    const segments = entry.path.split('/')
    const src = resolveInsideRoot(srcDir, segments)
    const stat = await fsp.lstat(src).catch(() => null)
    if (!stat?.isFile()) throw new Error(`install-failed:missing ${entry.path}`)
    if (stat.size > PLUGIN_LIMITS.fileBytes) throw new Error('limit-exceeded:file-size')
    bytes += stat.size
    if (bytes > PLUGIN_LIMITS.totalBytes) throw new Error('limit-exceeded:total-size')
    await assertRealpathInside(srcDir, src)
    const content = await fsp.readFile(src)
    const target = resolveInsideRoot(dest, segments)
    await fsp.mkdir(path.dirname(target), { recursive: true })
    const mode = entry.mode === 'executable' ? 0o755 : 0o644
    const handle = await fsp.open(target, 'wx', mode)
    try {
      await handle.writeFile(content)
    } finally {
      await handle.close()
    }
    await fsp.chmod(target, mode)
    lines.push(`${entry.path}\0${entry.mode}\0${sha256(content)}\n`)
  }
  return { digest: sha256(lines.sort().join('')), files: files.length, bytes, skipped }
}

/** Namespaced names of a package's skills and commands. */
export function packageSkillNames(pkg: PluginPackage): string[] {
  return pkg.skills.map((skill) => normalizeSkillName(`${pkg.name}:${skill.name}`))
}

async function stageAndPlace(
  p: PreparedInstall,
  deps: InstallerDeps
): Promise<{ dirName: string; digest: string; created: boolean }> {
  const staging = path.join(deps.layout.staging(), randomUUID())
  try {
    const copied = await copyPluginTree(p.checkoutDir, p.entries, staging)
    const dirName = copied.digest.slice(0, 12)
    const keyHash = pluginKeyHash(p.key)
    const target = deps.layout.packageDir(keyHash, dirName)
    await fsp.mkdir(deps.layout.packages(keyHash), { recursive: true })
    if (existsSync(target)) {
      await fsp.rm(staging, { recursive: true, force: true })
      return { dirName, digest: copied.digest, created: false }
    }
    await fsp.rename(staging, target)
    return { dirName, digest: copied.digest, created: true }
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

function validInputs(pkg: PluginPackage, values: Record<string, string> | undefined): Record<string, string> {
  const ids = new Set(pkg.inputs.map((input) => input.id))
  const out: Record<string, string> = {}
  for (const [id, value] of Object.entries(values ?? {})) {
    if (!ids.has(id)) throw new InstallError('invalid-input', `unknown input ${id}`)
    if (typeof value !== 'string') throw new InstallError('invalid-input', `invalid value for ${id}`)
    if (value !== '') out[id] = value
  }
  return out
}

function stdioConsent(pkg: PluginPackage, approved: Iterable<string>): Record<string, string> {
  const keys = new Set(approved)
  const out: Record<string, string> = {}
  for (const server of pkg.mcpServers)
    if (server.transport === 'stdio' && keys.has(server.key)) out[server.key] = launchDigest(server)
  return out
}

function serverRecords(
  key: string,
  pkg: PluginPackage,
  consent: Record<string, string>,
  previous: InstalledPluginRecord['servers'] = {}
): InstalledPluginRecord['servers'] {
  const out: InstalledPluginRecord['servers'] = {}
  for (const server of pkg.mcpServers) {
    const consented = server.transport !== 'stdio' || consent[server.key] === launchDigest(server)
    const usable = server.auth.kind !== 'unusable'
    const enabled = previous[server.key]
      ? previous[server.key].enabled && consented && usable
      : server.enabledByDefault && consented && usable
    out[server.key] = { id: pluginServerId(key, server.key), enabled }
  }
  return out
}

export async function installPrepared(
  p: PreparedInstall,
  req: { consent: PluginConsentInput; scope: PluginScope; inputs?: Record<string, string> },
  deps: InstallerDeps
): Promise<PluginOpResult<InstalledPluginRecord>> {
  const { inspection } = p
  const pkg = inspection.pkg
  if (!pkg || inspection.compatibility.level === 'unavailable') return { ok: false, error: 'unavailable' }
  if (req.consent.consentFingerprint !== inspection.consentFingerprint)
    return { ok: false, error: 'consent-required', detail: inspection.consentFingerprint }
  if (inspection.executables.length && !req.consent.executables)
    return { ok: false, error: 'consent-required', detail: inspection.consentFingerprint }
  const installed = listInstalled()
  if (installed[p.key]) return { ok: false, error: 'already-installed' }
  if (Object.values(installed).some((record) => record.name === p.name)) return { ok: false, error: 'name-conflict' }

  let wroteSecrets = false
  let created: string | null = null
  try {
    const inputs = validInputs(pkg, req.inputs)
    if (Object.keys(inputs).length) {
      writePluginSecrets(p.key, inputs)
      wroteSecrets = true
    }
    const now = deps.now()
    const consent = stdioConsent(pkg, req.consent.stdio)
    const record: InstalledPluginRecord = {
      key: p.key,
      name: p.name,
      marketplaceId: p.marketplaceId,
      source: p.source,
      format: pkg.format,
      version: pkg.version,
      commit: p.commit,
      treeOid: p.treeOid,
      digest: '',
      dirName: '',
      enabled: true,
      scope: req.scope,
      consent: {
        stdio: consent,
        executables: inspection.executables.length ? req.consent.executables : false,
        fingerprint: inspection.consentFingerprint,
        acceptedAt: now,
      },
      servers: serverRecords(p.key, pkg, consent),
      available: null,
      status: 'installing',
      previous: null,
      installedAt: now,
      updatedAt: now,
      skillNames: packageSkillNames(pkg),
      ...(p.loadOptions ? { loadOptions: p.loadOptions } : {}),
      displayName: pkg.displayName ?? pkg.name,
      ...(p.policy ? { policy: p.policy } : {}),
      mcpServers: pkg.mcpServers,
      inputs: pkg.inputs,
    }
    writeInstalled((all) => {
      all[p.key] = record
    })
    const placed = await stageAndPlace(p, deps)
    if (placed.created) created = deps.layout.packageDir(pluginKeyHash(p.key), placed.dirName)
    await fsp.mkdir(deps.layout.data(pluginKeyHash(p.key)), { recursive: true })
    const ready: InstalledPluginRecord = { ...record, dirName: placed.dirName, digest: placed.digest, status: 'ready' }
    writeInstalled((all) => {
      all[p.key] = ready
    })
    return { ok: true, value: ready }
  } catch (error) {
    if (created) await fsp.rm(created, { recursive: true, force: true }).catch(() => undefined)
    try {
      writeInstalled((all) => {
        delete all[p.key]
      })
      if (wroteSecrets) removePluginSecrets(p.key)
    } catch {
      // Startup reconciliation removes what remains.
    }
    return errorResult(error)
  }
}

export async function updatePrepared(
  key: string,
  p: PreparedInstall,
  consent: PluginConsentInput | undefined,
  deps: InstallerDeps
): Promise<PluginOpResult<InstalledPluginRecord>> {
  const record = listInstalled()[key]
  if (!record || record.status !== 'ready') return { ok: false, error: 'unknown-plugin' }
  const { inspection } = p
  const pkg = inspection.pkg
  if (!pkg || inspection.compatibility.level === 'unavailable') return { ok: false, error: 'unavailable' }
  const fingerprintChanged = inspection.consentFingerprint !== record.consent.fingerprint
  if (consent && consent.consentFingerprint !== inspection.consentFingerprint)
    return { ok: false, error: 'consent-required', detail: inspection.consentFingerprint }
  if (fingerprintChanged && !consent)
    return { ok: false, error: 'consent-required', detail: inspection.consentFingerprint }
  const executables = consent ? consent.executables : record.consent.executables
  if (inspection.executables.length && !executables)
    return { ok: false, error: 'consent-required', detail: inspection.consentFingerprint }

  const stdio = consent
    ? stdioConsent(pkg, consent.stdio)
    : stdioConsent(
        pkg,
        pkg.mcpServers
          .filter((server) => server.transport === 'stdio' && record.consent.stdio[server.key] === launchDigest(server))
          .map((server) => server.key)
      )
  const previous = { dirName: record.dirName, commit: record.commit, treeOid: record.treeOid, digest: record.digest }
  writeInstalled((all) => {
    all[key] = { ...record, status: 'updating', previous }
  })
  let created: string | null = null
  try {
    const placed = await stageAndPlace(p, deps)
    if (placed.created) created = deps.layout.packageDir(pluginKeyHash(key), placed.dirName)
    await fsp.mkdir(deps.layout.data(pluginKeyHash(key)), { recursive: true })
    const now = deps.now()
    const servers = serverRecords(key, pkg, stdio, record.servers)
    const removedServers = Object.entries(record.servers)
      .filter(([serverKey]) => !servers[serverKey])
      .map(([, server]) => server.id)
    const skillNames = packageSkillNames(pkg)
    const removedSkills = (record.skillNames ?? []).filter((name) => !skillNames.includes(name))
    const next: InstalledPluginRecord = {
      ...record,
      format: pkg.format,
      version: pkg.version,
      commit: p.commit,
      treeOid: p.treeOid,
      digest: placed.digest,
      dirName: placed.dirName,
      source: p.source,
      consent: {
        stdio,
        executables: inspection.executables.length ? executables : false,
        fingerprint: inspection.consentFingerprint,
        acceptedAt: consent ? now : record.consent.acceptedAt,
      },
      servers,
      available: null,
      status: 'ready',
      previous: null,
      updatedAt: now,
      skillNames,
      ...(p.loadOptions ? { loadOptions: p.loadOptions } : {}),
      displayName: pkg.displayName ?? pkg.name,
      ...(p.policy ? { policy: p.policy } : {}),
      mcpServers: pkg.mcpServers,
      inputs: pkg.inputs,
    }
    writeInstalled((all) => {
      all[key] = next
    })
    // Paths and configuration changed: every server of the plugin reconnects on next use.
    for (const server of Object.values(record.servers)) deps.invalidateServer(server.id)
    for (const id of removedServers) {
      deps.invalidateServer(id)
      deps.forgetServer(id)
    }
    if (removedSkills.length) deps.onSkillsRemoved(removedSkills)
    if (placed.dirName !== previous.dirName)
      await fsp
        .rm(deps.layout.packageDir(pluginKeyHash(key), previous.dirName), { recursive: true, force: true })
        .catch(() => undefined)
    return { ok: true, value: next }
  } catch (error) {
    if (created) await fsp.rm(created, { recursive: true, force: true }).catch(() => undefined)
    try {
      writeInstalled((all) => {
        all[key] = { ...record, status: 'ready', previous: null }
      })
    } catch {
      // Startup reconciliation rolls the record back.
    }
    return errorResult(error)
  }
}

async function removeEverything(
  record: InstalledPluginRecord,
  deleteData: boolean,
  deps: InstallerDeps
): Promise<void> {
  for (const server of Object.values(record.servers)) {
    deps.invalidateServer(server.id)
    deps.forgetServer(server.id)
  }
  if (record.skillNames?.length) deps.onSkillsRemoved(record.skillNames)
  removePluginSecrets(record.key)
  const keyHash = pluginKeyHash(record.key)
  await fsp.rm(deps.layout.packages(keyHash), { recursive: true, force: true })
  if (deleteData) await fsp.rm(deps.layout.data(keyHash), { recursive: true, force: true })
}

export async function uninstallPlugin(
  key: string,
  opts: { deleteData: boolean },
  deps: InstallerDeps
): Promise<PluginOpResult> {
  const record = listInstalled()[key]
  if (!record) return { ok: false, error: 'unknown-plugin' }
  try {
    writeInstalled((all) => {
      all[key] = { ...record, status: 'removing' }
    })
    await removeEverything(record, opts.deleteData, deps)
    writeInstalled((all) => {
      delete all[key]
    })
    return { ok: true, value: undefined }
  } catch (error) {
    return errorResult(error)
  }
}

async function listDir(dir: string): Promise<string[]> {
  return fsp.readdir(dir).catch(() => [] as string[])
}

/** Finishes removals, rolls back interrupted installs and updates, and deletes unreferenced directories. */
export async function reconcilePlugins(
  deps: InstallerDeps
): Promise<{ finishedRemovals: string[]; rolledBack: string[]; deletedDirs: string[] }> {
  const finishedRemovals: string[] = []
  const rolledBack: string[] = []
  const deletedDirs: string[] = []
  for (const record of Object.values(listInstalled())) {
    if (record.status === 'removing') {
      await removeEverything(record, false, deps).catch(() => undefined)
      writeInstalled((all) => {
        delete all[record.key]
      })
      finishedRemovals.push(record.key)
    } else if (record.status === 'installing') {
      removePluginSecrets(record.key)
      writeInstalled((all) => {
        delete all[record.key]
      })
      rolledBack.push(record.key)
    } else if (record.status === 'updating') {
      writeInstalled((all) => {
        const current = all[record.key]
        if (!current) return
        all[record.key] = current.previous
          ? { ...current, ...current.previous, status: 'ready', previous: null }
          : { ...current, status: 'ready' }
      })
      rolledBack.push(record.key)
    }
  }
  const records = Object.values(listInstalled())
  const byHash = new Map(records.map((record) => [pluginKeyHash(record.key), record]))
  const packagesRoot = path.join(deps.layout.root, 'packages')
  for (const keyHash of await listDir(packagesRoot)) {
    const record = byHash.get(keyHash)
    const dir = path.join(packagesRoot, keyHash)
    if (!record) {
      await fsp.rm(dir, { recursive: true, force: true })
      deletedDirs.push(dir)
      continue
    }
    for (const version of await listDir(dir)) {
      if (version === record.dirName) continue
      await fsp.rm(path.join(dir, version), { recursive: true, force: true })
      deletedDirs.push(path.join(dir, version))
    }
  }
  const staging = deps.layout.staging()
  for (const name of await listDir(staging)) {
    const stat = await fsp.stat(path.join(staging, name)).catch(() => null)
    if (stat && deps.now() - stat.mtimeMs > PLUGIN_LIMITS.stagingMaxAgeMs) {
      await fsp.rm(path.join(staging, name), { recursive: true, force: true })
      deletedDirs.push(path.join(staging, name))
    }
  }
  return { finishedRemovals, rolledBack, deletedDirs }
}

/** Input ids the plugin's stored values cover (never the values). */
export function storedInputIds(key: string): Set<string> {
  return new Set(Object.keys(readPluginSecrets(key) ?? {}))
}
