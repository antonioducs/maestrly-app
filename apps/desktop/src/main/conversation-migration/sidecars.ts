import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
import type { IgnoredMigrationEntry, SidecarMutation } from '../../shared/conversation-migration'
import { listIgnoredTransferCandidates } from '../local-conversation/git'
import { copyConversationNotebookBetweenCwds, planConversationNotebookCopyAtCwd } from '../notes/notes-service'

export const MAX_IGNORED_ENTRY_BYTES = 25 * 1024 * 1024
export const MAX_IGNORED_TOTAL_BYTES = 100 * 1024 * 1024

const generatedPaths = new Set([
  '.maestrly/agent-selection.json',
  '.maestrly/agent-open-file.json',
  '.maestrly/agent-navigation.json',
  '.maestrly/debug-cmd.json',
  '.maestrly/debug-result.json',
])

interface TreeSnapshot {
  entry: 'file' | 'directory'
  size: number
  mode: number
  sha256: string
}

export interface SidecarInspection {
  ignored: IgnoredMigrationEntry[]
  warnings: string[]
}

export interface ApplySidecarsArgs {
  sourceCwd: string
  destinationCwd: string
  targetOid: string
  selectedIgnoredPaths: string[]
  confirmedSensitivePaths: string[]
}

export interface ApplySidecarsResult {
  mutations: SidecarMutation[]
  warnings: string[]
}

export interface MigrationSidecarPlan extends ApplySidecarsResult {}

function exactRelative(raw: string): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || path.isAbsolute(raw)) return null
  const segments = raw.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return raw
}

function isGitPath(relative: string): boolean {
  return relative.split('/').some((segment) => segment.toLowerCase() === '.git')
}

function isGeneratedPath(relative: string): boolean {
  return generatedPaths.has(relative)
}

function isSensitivePath(relative: string): boolean {
  const name = path.posix.basename(relative).toLowerCase()
  return (
    name === '.env' ||
    name.startsWith('.env.') ||
    name === '.npmrc' ||
    name === '.pypirc' ||
    name === '.netrc' ||
    name === 'credentials' ||
    name === 'credentials.json' ||
    name === 'id_rsa' ||
    name === 'id_ed25519' ||
    /(^|[._-])(secret|secrets|token|tokens|credential|credentials|private[-_]?key)([._-]|$)/i.test(name) ||
    /\.(pem|key|p12|pfx|keystore)$/i.test(name)
  )
}

async function hashFile(file: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
  let size = 0
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += value.byteLength
      if (size > maxBytes) {
        stream.destroy(new Error(`Entrada maior que ${Math.floor(maxBytes / 1024 / 1024)} MB.`))
        return
      }
      hash.update(value)
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return { size, sha256: hash.digest('hex') }
}

function confinedPath(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root)
  const absolute = path.resolve(resolvedRoot, ...relative.split('/'))
  if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path outside the authorized directory: ${relative}`)
  }
  return absolute
}

async function safeTreeSnapshot(rootCwd: string, relative: string, maxBytes: number): Promise<TreeSnapshot> {
  const rootReal = await fs.realpath(rootCwd)
  const absolute = confinedPath(rootCwd, relative)
  const expectedReal = confinedPath(rootReal, relative)
  const actualReal = await fs.realpath(absolute)
  if (actualReal !== expectedReal) throw new Error(`Symlink/junction not allowed: ${relative}`)

  const rootStat = await fs.lstat(absolute)
  if (rootStat.isSymbolicLink()) throw new Error(`Symlink not allowed: ${relative}`)
  const hash = createHash('sha256')
  let size = 0
  const account = (amount: number): void => {
    size += amount
    if (size > maxBytes) throw new Error(`Entrada maior que ${Math.floor(maxBytes / 1024 / 1024)} MB.`)
  }
  const visit = async (current: string, nested: string): Promise<void> => {
    const stat = await fs.lstat(current)
    const currentReal = await fs.realpath(current)
    const expected = path.resolve(expectedReal, ...nested.split('/').filter(Boolean))
    if (currentReal !== expected || stat.isSymbolicLink()) {
      throw new Error(`Symlink/junction not allowed: ${nested || relative}`)
    }
    if (stat.isFile()) {
      account(stat.size)
      const file = await hashFile(current, maxBytes)
      if (file.size !== stat.size) throw new Error(`${nested || relative} changed during reading.`)
      hash.update(`f\0${nested}\0${stat.mode & 0o7777}\0${file.size}\0${file.sha256}\0`)
      return
    }
    if (!stat.isDirectory()) throw new Error(`Special file not allowed: ${nested || relative}`)
    hash.update(`d\0${nested}\0${stat.mode & 0o7777}\0`)
    const entries = await fs.readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      await visit(path.join(current, entry.name), nested ? `${nested}/${entry.name}` : entry.name)
    }
  }
  await visit(absolute, '')
  return {
    entry: rootStat.isDirectory() ? 'directory' : 'file',
    size,
    mode: rootStat.mode & 0o7777,
    sha256: hash.digest('hex'),
  }
}

function isSameOrAncestor(relative: string, target: string): boolean {
  return relative === target || target.startsWith(`${relative}/`)
}

function mutationToken(mutation: SidecarMutation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        path: mutation.path,
        kind: mutation.kind,
        entry: mutation.entry,
        created: mutation.created,
        before: mutation.beforeContentBase64,
        beforeMode: mutation.beforeMode,
        after: mutation.afterSha256,
        afterMode: mutation.afterMode,
      })
    )
    .digest('hex')
    .slice(0, 24)
}

function sidecarPlanToken(mutations: SidecarMutation[]): string {
  return createHash('sha256').update(mutations.map(mutationToken).join('\0')).digest('hex').slice(0, 24)
}

async function quarantineInstalledMutation(destinationCwd: string, mutation: SidecarMutation): Promise<boolean> {
  if (!mutation.afterSha256) return false
  const current = await currentMutationHash(destinationCwd, mutation)
  if (current === null) return true
  if (current !== mutation.afterSha256) return false
  const target = confinedPath(destinationCwd, mutation.path)
  const parent = await ensureSafeDestinationParent(destinationCwd, mutation.path)
  const quarantine = path.join(destinationCwd, `.migration-cleanup-${mutationToken(mutation)}`)
  if (!(await pathIsMissing(quarantine))) return false
  await assertSafeDestinationParent(destinationCwd, mutation.path, parent)
  try {
    await fs.rename(target, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  // A writer may keep an isolated inode open. Compensation never destroys it or overwrites through rename;
  // manual recovery decides how to use the preserved artifact.
  return false
}

function reservedDescendant(relative: string): string | null {
  if (isGitPath(relative) || isSameOrAncestor(relative, '.git')) return '.git'
  if (isSameOrAncestor(relative, '.agents/notes') || isSameOrAncestor(relative, '.agents/notes.md')) {
    return '.agents/notes'
  }
  for (const generated of generatedPaths) {
    if (isSameOrAncestor(relative, generated) || isSameOrAncestor(generated, relative)) return generated
  }
  return null
}

async function containedReservedDescendant(root: string, relative: string): Promise<string | null> {
  const absolute = confinedPath(root, relative)
  const stat = await fs.lstat(absolute)
  if (!stat.isDirectory()) return null
  const walk = async (dir: string, prefix: string): Promise<string | null> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const nested = prefix ? `${prefix}/${entry.name}` : entry.name
      const reserved = reservedDescendant(nested)
      if (reserved) return reserved
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const descendant = await walk(path.join(dir, entry.name), nested)
        if (descendant) return descendant
      }
    }
    return null
  }
  return walk(absolute, '')
}

async function containsSensitiveDescendant(root: string, relative: string): Promise<boolean> {
  const absolute = confinedPath(root, relative)
  const stat = await fs.lstat(absolute)
  if (!stat.isDirectory()) return isSensitivePath(relative)
  const walk = async (dir: string, prefix: string): Promise<boolean> => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const nested = prefix ? `${prefix}/${entry.name}` : entry.name
      if (isSensitivePath(`${relative}/${nested}`)) return true
      if (entry.isDirectory() && !entry.isSymbolicLink() && (await walk(path.join(dir, entry.name), nested)))
        return true
    }
    return false
  }
  return walk(absolute, '')
}

function reasonForReservedPath(relative: string): string | null {
  const reserved = reservedDescendant(relative)
  if (reserved === '.git') return '.git must never be migrated.'
  if (reserved === '.agents/notes')
    return 'Notes migrate automatically and are excluded from the ignored-file selection.'
  if (reserved || isGeneratedPath(relative)) return 'Ephemeral file generated by Maestrly.'
  return null
}

export async function inspectMigrationSidecars(sourceCwd: string, targetOid: string): Promise<SidecarInspection> {
  const candidates = await listIgnoredTransferCandidates(sourceCwd, targetOid)
  const ignored: IgnoredMigrationEntry[] = []
  const warnings: string[] = []
  for (const candidate of candidates) {
    const relative = exactRelative(candidate.path)
    if (!relative) continue
    let size = candidate.size
    let kind = candidate.kind
    let reason = candidate.trackedCollision
      ? 'Collides with a tracked destination path.'
      : reasonForReservedPath(relative)
    let reasonCode: IgnoredMigrationEntry['reasonCode'] | undefined = candidate.trackedCollision
      ? 'tracked-collision'
      : reason
        ? 'reserved'
        : undefined
    if (!reason && (kind === 'symlink' || kind === 'other')) {
      reason = 'Links and special files are not copied.'
      reasonCode = 'unsupported'
    }
    if (!reason) {
      try {
        const snapshot = await safeTreeSnapshot(sourceCwd, relative, MAX_IGNORED_ENTRY_BYTES)
        size = snapshot.size
        kind = snapshot.entry
        const reserved = kind === 'directory' ? await containedReservedDescendant(sourceCwd, relative) : null
        if (reserved) {
          reason = reasonForReservedPath(reserved) ?? `The directory contains a reserved path: ${reserved}`
          reasonCode = 'reserved'
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error)
        reasonCode = 'unsafe'
      }
    }
    const sensitive =
      isSensitivePath(relative) ||
      (!reason && kind === 'directory' && (await containsSensitiveDescendant(sourceCwd, relative)))
    ignored.push({
      path: relative,
      size,
      kind,
      sensitive,
      selectable: !reason,
      ...(reasonCode ? { reasonCode } : {}),
      ...(reason ? { reason } : {}),
    })
    if (reason && !reason.includes('automatically') && !reason.includes('Ephemeral')) {
      warnings.push(`${relative}: ${reason}`)
    }
  }
  return { ignored, warnings }
}

async function ensureSafeDestinationParent(root: string, relative: string): Promise<string> {
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error('The destination is not a regular directory.')
  const rootReal = await fs.realpath(root)
  const parentRelative = path.posix.dirname(relative)
  let current = path.resolve(root)
  if (parentRelative !== '.') {
    for (const component of parentRelative.split('/')) {
      current = path.join(current, component)
      try {
        const stat = await fs.lstat(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Unsafe ancestor in destination: ${component}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await fs.mkdir(current)
      }
      const currentReal = await fs.realpath(current)
      if (currentReal !== rootReal && !currentReal.startsWith(`${rootReal}${path.sep}`)) {
        throw new Error(`Ancestor outside destination: ${component}`)
      }
    }
  }
  return current
}

async function assertSafeDestinationParent(root: string, relative: string, expectedParent: string): Promise<void> {
  const parent = await ensureSafeDestinationParent(root, relative)
  if (path.resolve(parent) !== path.resolve(expectedParent)) {
    throw new Error(`The ancestor of ${relative} changed during migration.`)
  }
  const [rootReal, parentReal] = await Promise.all([fs.realpath(root), fs.realpath(parent)])
  const expectedReal = path.resolve(
    rootReal,
    ...path.posix
      .dirname(relative)
      .split('/')
      .filter((component) => component !== '.')
  )
  if (parentReal !== expectedReal) throw new Error(`The ancestor of ${relative} escaped the destination.`)
}

async function copySafeEntry(
  sourceCwd: string,
  destinationCwd: string,
  relative: string,
  confirmedSensitive: boolean,
  planned?: SidecarMutation
): Promise<SidecarMutation> {
  const before = await safeTreeSnapshot(sourceCwd, relative, MAX_IGNORED_ENTRY_BYTES)
  if (
    planned &&
    (planned.path !== relative ||
      planned.kind !== 'ignored' ||
      planned.entry !== before.entry ||
      planned.afterSha256 !== before.sha256 ||
      planned.afterMode !== before.mode)
  ) {
    throw new Error(`${relative} changed since the copy was planned.`)
  }
  const reserved = before.entry === 'directory' ? await containedReservedDescendant(sourceCwd, relative) : null
  if (reserved) throw new Error(`${relative} now contains reserved path ${reserved}.`)
  const sensitive =
    isSensitivePath(relative) ||
    (before.entry === 'directory' && (await containsSensitiveDescendant(sourceCwd, relative)))
  if (sensitive && !confirmedSensitive) {
    throw new Error(`${relative} requires additional confirmation because it may contain a secret.`)
  }
  const destination = confinedPath(destinationCwd, relative)
  try {
    await fs.lstat(destination)
    throw new Error(`The destination already contains ${relative}.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = await ensureSafeDestinationParent(destinationCwd, relative)
  const journalMutation: SidecarMutation = planned ?? {
    path: relative,
    kind: 'ignored',
    entry: before.entry,
    created: true,
    afterSha256: before.sha256,
    afterMode: before.mode,
  }
  const staging = path.join(parent, `.migration-${mutationToken(journalMutation)}`)
  let installed = false
  try {
    const stagedHash = await artifactHash(parent, staging)
    if (stagedHash !== null && stagedHash !== before.sha256) {
      throw new Error(`Staging for ${relative} differs from the journal; manual review is required.`)
    }
    if (stagedHash === null) {
      if (before.entry === 'directory') {
        await fs.cp(path.join(sourceCwd, ...relative.split('/')), staging, {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
          errorOnExist: true,
          force: false,
        })
      } else {
        await fs.copyFile(path.join(sourceCwd, ...relative.split('/')), staging, fsConstants.COPYFILE_EXCL)
        await fs.chmod(staging, before.mode).catch(() => {})
      }
    }
    const [sourceAfter, staged] = await Promise.all([
      safeTreeSnapshot(sourceCwd, relative, MAX_IGNORED_ENTRY_BYTES),
      safeTreeSnapshot(parent, path.basename(staging), MAX_IGNORED_ENTRY_BYTES),
    ])
    if (sourceAfter.sha256 !== before.sha256 || staged.sha256 !== before.sha256) {
      throw new Error(`${relative} changed during copying.`)
    }
    await assertSafeDestinationParent(destinationCwd, relative, parent)
    if (before.entry === 'file') {
      // Install without overwrite: concurrent destination creation must raise EEXIST rather than silently
      // lose data.
      await fs.link(staging, destination)
      installed = true
      await fs.rm(staging)
    } else {
      // POSIX directory rename rejects a nonempty concurrent destination. Replacing an empty directory
      // changes only its entry; subsequent verification detects races.
      await fs.rename(staging, destination)
      installed = true
    }
    return {
      path: relative,
      kind: 'ignored',
      entry: before.entry,
      created: true,
      afterSha256: before.sha256,
      afterMode: before.mode,
    }
  } catch (error) {
    const stagingClean = await failedArtifactIsAbsent(parent, staging).catch(() => false)
    if (
      !stagingClean ||
      (installed && !(await quarantineInstalledMutation(destinationCwd, journalMutation).catch(() => false)))
    ) {
      throw new Error(`Installing ${relative} failed and requires manual recovery: ${String(error)}`)
    }
    throw error
  }
}

async function artifactHash(
  parent: string,
  artifact: string,
  maxBytes = MAX_IGNORED_ENTRY_BYTES
): Promise<string | null> {
  try {
    return (await safeTreeSnapshot(parent, path.basename(artifact), maxBytes)).sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function failedArtifactIsAbsent(
  parent: string,
  artifact: string,
  maxBytes = MAX_IGNORED_ENTRY_BYTES
): Promise<boolean> {
  return (await artifactHash(parent, artifact, maxBytes)) === null
}

function sidecarStagingPath(destinationCwd: string, mutation: SidecarMutation): string | null {
  const destination = confinedPath(destinationCwd, mutation.path)
  const parent = path.dirname(destination)
  const token = mutationToken(mutation)
  if (mutation.kind === 'ignored') return path.join(parent, `.migration-${token}`)
  if (mutation.kind === 'note') {
    return path.join(parent, mutation.entry === 'directory' ? `.notes-migration-${token}` : `.legacy-notes-${token}`)
  }
  return null
}

async function cleanupSidecarStaging(destinationCwd: string, mutation: SidecarMutation): Promise<void> {
  const staging = sidecarStagingPath(destinationCwd, mutation)
  if (!staging || !mutation.afterSha256) return
  const current = await artifactHash(
    path.dirname(staging),
    staging,
    mutation.kind === 'note' ? Number.MAX_SAFE_INTEGER : MAX_IGNORED_ENTRY_BYTES
  )
  if (current === null) return
  if (current !== mutation.afterSha256) {
    throw new Error(`Staging for ${mutation.path} differs from the journal; manual review is required.`)
  }
  await fs.rm(staging, { recursive: true })
}

async function mutationMatches(
  root: string,
  relative: string,
  mutation: SidecarMutation,
  maxBytes = mutation.kind === 'note' ? Number.MAX_SAFE_INTEGER : MAX_IGNORED_ENTRY_BYTES
): Promise<boolean> {
  try {
    return (await safeTreeSnapshot(root, relative, maxBytes)).sha256 === mutation.afterSha256
  } catch {
    return false
  }
}

async function currentMutationHash(destinationCwd: string, mutation: SidecarMutation): Promise<string | null> {
  try {
    return (
      await safeTreeSnapshot(
        destinationCwd,
        mutation.path,
        mutation.kind === 'note' ? Number.MAX_SAFE_INTEGER : MAX_IGNORED_ENTRY_BYTES
      )
    ).sha256
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function verifyMigrationSidecars(destinationCwd: string, mutations: SidecarMutation[]): Promise<boolean> {
  try {
    for (const mutation of mutations) {
      if (!mutation.afterSha256) return false
      if (!(await mutationMatches(destinationCwd, mutation.path, mutation))) return false
      await cleanupSidecarStaging(destinationCwd, mutation)
    }
    return true
  } catch {
    return false
  }
}

interface QuarantinedMutation {
  mutation: SidecarMutation
  target: string
  quarantined: string
  previousStaging?: string
  previousInstalled: boolean
}

function rollbackQuarantinePath(destinationCwd: string, mutations: SidecarMutation[]): string {
  return path.join(destinationCwd, `.migration-rollback-${sidecarPlanToken(mutations)}`)
}

async function recoverSidecarRollbackQuarantine(
  destinationCwd: string,
  mutations: SidecarMutation[]
): Promise<boolean> {
  const quarantine = rollbackQuarantinePath(destinationCwd, mutations)
  if (await pathIsMissing(quarantine)) return true
  const expectedNames = new Set(
    mutations.flatMap((mutation) => {
      const token = mutationToken(mutation)
      return [`migrated-${token}`, `previous-${token}`]
    })
  )
  const names = await fs.readdir(quarantine)
  if (names.some((name) => !expectedNames.has(name))) return false
  const moved: QuarantinedMutation[] = []
  for (const mutation of [...mutations].reverse()) {
    const token = mutationToken(mutation)
    const quarantined = path.join(quarantine, `migrated-${token}`)
    const quarantinedHash = await artifactHash(quarantine, quarantined)
    if (quarantinedHash === null) continue
    if (!mutation.afterSha256 || !(await mutationMatches(quarantine, path.basename(quarantined), mutation))) {
      return false
    }
    const previousStaging = path.join(quarantine, `previous-${token}`)
    const previousStagingHash = await artifactHash(quarantine, previousStaging)
    const expectedPrevious = previousMutationHash(mutation)
    if (previousStagingHash !== null && previousStagingHash !== expectedPrevious) return false
    moved.push({
      mutation,
      target: confinedPath(destinationCwd, mutation.path),
      quarantined,
      previousStaging,
      previousInstalled: false,
    })
  }
  for (const item of moved) {
    const { mutation, target, quarantined, previousStaging } = item
    const current = await currentMutationHash(destinationCwd, mutation)
    const previous = previousMutationHash(mutation)
    if (!mutation.created && current === previous && previousStaging && (await pathIsMissing(previousStaging))) {
      await fs.rename(target, previousStaging)
      item.previousInstalled = false
    } else if (current !== null) {
      return false
    }
    await ensureSafeDestinationParent(destinationCwd, mutation.path)
    await fs.rename(quarantined, target)
  }
  if (
    !(await verifyMigrationSidecars(
      destinationCwd,
      moved.map((item) => item.mutation)
    ))
  )
    return false
  await fs.rm(quarantine, { recursive: true })
  return true
}

async function pathIsMissing(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}

function previousMutationHash(mutation: SidecarMutation): string | null {
  if (mutation.beforeContentBase64 === undefined || mutation.beforeMode === undefined) return null
  const content = Buffer.from(mutation.beforeContentBase64, 'base64')
  const contentHash = createHash('sha256').update(content).digest('hex')
  return createHash('sha256')
    .update(`f\0\0${mutation.beforeMode}\0${content.byteLength}\0${contentHash}\0`)
    .digest('hex')
}

async function restoreQuarantinedMutations(destinationCwd: string, moved: QuarantinedMutation[]): Promise<void> {
  for (const item of [...moved].reverse()) {
    const { mutation, target, quarantined, previousStaging } = item
    if (item.previousInstalled) {
      let removePrevious = false
      try {
        const expectedPrevious = previousMutationHash(mutation)
        const currentPrevious = await currentMutationHash(destinationCwd, mutation)
        if (
          expectedPrevious &&
          currentPrevious === expectedPrevious &&
          previousStaging &&
          (await pathIsMissing(previousStaging))
        ) {
          await fs.rename(target, previousStaging)
          item.previousInstalled = false
          removePrevious = true
        }
      } catch {
        continue // never delete or overwrite content that could not be preserved
      }
      if (!removePrevious) continue
    }
    try {
      if (!(await pathIsMissing(target))) continue // external work appeared; do not overwrite
      await ensureSafeDestinationParent(destinationCwd, mutation.path)
      await fs.rename(quarantined, target)
    } catch {
      /* manual recovery retains all remaining quarantined content */
    }
  }
}

export async function migrationSidecarsAreRolledBack(
  destinationCwd: string,
  mutations: SidecarMutation[]
): Promise<boolean> {
  try {
    if (!(await recoverSidecarRollbackQuarantine(destinationCwd, mutations))) return false
    for (const mutation of mutations) {
      await cleanupSidecarStaging(destinationCwd, mutation)
      const current = await currentMutationHash(destinationCwd, mutation)
      if (mutation.created) {
        if (current !== null) return false
      } else if (current !== previousMutationHash(mutation)) {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

export async function rollbackMigrationSidecars(
  destinationCwd: string,
  mutations: SidecarMutation[]
): Promise<boolean> {
  const pending: SidecarMutation[] = []
  try {
    if (!(await recoverSidecarRollbackQuarantine(destinationCwd, mutations))) return false
    for (const mutation of mutations) {
      await cleanupSidecarStaging(destinationCwd, mutation)
      const current = await currentMutationHash(destinationCwd, mutation)
      const previous = previousMutationHash(mutation)
      if (mutation.created && current === null) continue
      if (!mutation.created && current === previous) continue
      if (current !== mutation.afterSha256 && !(await mutationMatches(destinationCwd, mutation.path, mutation))) {
        return false
      }
      pending.push(mutation)
    }
  } catch {
    return false
  }
  if (pending.length === 0) return true
  const rootStat = await fs.lstat(destinationCwd).catch(() => null)
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return false
  const quarantine = rollbackQuarantinePath(destinationCwd, mutations)
  const moved: QuarantinedMutation[] = []
  try {
    await fs.mkdir(quarantine)
    for (const mutation of [...pending].reverse()) {
      if (!mutation.afterSha256 || !(await mutationMatches(destinationCwd, mutation.path, mutation))) {
        throw new Error(`Sidecar ${mutation.path} changed after migration.`)
      }
      if (!mutation.created && mutation.beforeContentBase64 === undefined) {
        throw new Error(`Missing backup for ${mutation.path}.`)
      }
      const target = confinedPath(destinationCwd, mutation.path)
      const quarantined = path.join(quarantine, `migrated-${mutationToken(mutation)}`)
      await fs.rename(target, quarantined)
      const movedItem: QuarantinedMutation = { mutation, target, quarantined, previousInstalled: false }
      moved.push(movedItem)
      if (!(await mutationMatches(quarantine, path.basename(quarantined), mutation))) {
        // A path changed between hashing and rename is concurrent work. Restore it immediately when safe;
        // if the destination was recreated, retain quarantine for manual recovery.
        if (await pathIsMissing(target)) {
          await ensureSafeDestinationParent(destinationCwd, mutation.path)
          await fs.rename(quarantined, target)
          moved.pop()
        }
        throw new Error(`Sidecar ${mutation.path} changed during rollback.`)
      }
    }

    // Isolate all sidecars before restoring preexisting entries so divergence cannot leave the journal
    // partially removed and partially active.
    for (const item of moved) {
      const { mutation, target } = item
      if (mutation.created) continue
      if (!(await pathIsMissing(target))) throw new Error(`Path ${mutation.path} was recreated during rollback.`)
      await ensureSafeDestinationParent(destinationCwd, mutation.path)
      const previousStaging = path.join(quarantine, `previous-${mutationToken(mutation)}`)
      await fs.writeFile(previousStaging, Buffer.from(mutation.beforeContentBase64!, 'base64'), {
        mode: mutation.beforeMode ?? 0o600,
        flag: 'wx',
      })
      if (mutation.beforeMode !== undefined) await fs.chmod(previousStaging, mutation.beforeMode).catch(() => {})
      item.previousStaging = previousStaging
      // Install only while the path remains absent; POSIX rename would silently overwrite.
      await fs.link(previousStaging, target)
      item.previousInstalled = true
      await fs.rm(previousStaging)
    }
    // Writers may retain an inode after quarantine rename. Delete quarantine only if its content still
    // matches immediately before removal.
    for (const { mutation, quarantined } of moved) {
      if (!(await mutationMatches(quarantine, path.basename(quarantined), mutation))) {
        throw new Error(`Sidecar ${mutation.path} changed inside quarantine.`)
      }
    }
    await fs.rm(quarantine, { recursive: true, force: true })
    return true
  } catch {
    await restoreQuarantinedMutations(destinationCwd, moved)
    // Remove quarantine only after full restoration to migrated state; otherwise it is durable recovery
    // data.
    const fullyRestored =
      moved.every((item) => !item.previousInstalled && path.basename(item.quarantined).startsWith('migrated-')) &&
      (await verifyMigrationSidecars(
        destinationCwd,
        moved.map((item) => item.mutation)
      ))
    if (fullyRestored) await fs.rm(quarantine, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

export function validateIgnoredSelection(
  ignored: IgnoredMigrationEntry[],
  selectedIgnoredPaths: string[],
  confirmedSensitivePaths: string[]
): string[] {
  const byPath = new Map(ignored.map((entry) => [entry.path, entry]))
  const selected = [...new Set(selectedIgnoredPaths.map(exactRelative))]
  if (selected.some((entry) => !entry)) throw new Error('The ignored-file selection contains an invalid path.')
  const selectedPaths = selected as string[]
  const confirmedEntries = confirmedSensitivePaths.map(exactRelative)
  if (confirmedEntries.some((entry) => !entry)) {
    throw new Error('The ignored-file confirmation contains an invalid path.')
  }
  const confirmed = new Set(confirmedEntries as string[])
  let ignoredBytes = 0
  for (const [index, relative] of selectedPaths.entries()) {
    if (selectedPaths.some((other, otherIndex) => otherIndex !== index && isSameOrAncestor(relative, other))) {
      throw new Error(`The ignored-file selection contains overlapping paths: ${relative}`)
    }
    const entry = byPath.get(relative)
    if (!entry?.selectable) throw new Error(`${relative} cannot be copied: ${entry?.reason ?? 'not inventoried'}`)
    if (entry.sensitive && !confirmed.has(relative)) {
      throw new Error(`${relative} requires additional confirmation because it may contain a secret.`)
    }
    ignoredBytes += entry.size
    if (ignoredBytes > MAX_IGNORED_TOTAL_BYTES) {
      throw new Error(`The ignored-file selection exceeds ${Math.floor(MAX_IGNORED_TOTAL_BYTES / 1024 / 1024)} MB.`)
    }
  }
  return selectedPaths
}

export async function planMigrationSidecars(args: ApplySidecarsArgs): Promise<MigrationSidecarPlan> {
  const inspection = await inspectMigrationSidecars(args.sourceCwd, args.targetOid)
  const selectedPaths = validateIgnoredSelection(
    inspection.ignored,
    args.selectedIgnoredPaths,
    args.confirmedSensitivePaths
  )
  const mutations: SidecarMutation[] = []
  const notes = await planConversationNotebookCopyAtCwd(args.sourceCwd)
  if (notes.copied && notes.relativePath && notes.entry && notes.sha256 && notes.mode !== undefined) {
    mutations.push({
      path: notes.relativePath,
      kind: 'note',
      entry: notes.entry,
      created: true,
      afterSha256: notes.sha256,
      afterMode: notes.mode,
    })
  } else if (notes.copied) {
    throw new Error('Notes planning did not produce a verifiable journal.')
  }
  for (const relative of selectedPaths) {
    const snapshot = await safeTreeSnapshot(args.sourceCwd, relative, MAX_IGNORED_ENTRY_BYTES)
    mutations.push({
      path: relative,
      kind: 'ignored',
      entry: snapshot.entry,
      created: true,
      afterSha256: snapshot.sha256,
      afterMode: snapshot.mode,
    })
  }
  return { mutations, warnings: [...inspection.warnings] }
}

export async function applyMigrationSidecars(
  args: ApplySidecarsArgs,
  existingPlan?: SidecarMutation[]
): Promise<ApplySidecarsResult> {
  const plan = existingPlan ? { mutations: existingPlan, warnings: [] } : await planMigrationSidecars(args)
  const applied: SidecarMutation[] = []
  try {
    for (const mutation of plan.mutations) {
      if (await mutationMatches(args.destinationCwd, mutation.path, mutation)) {
        await cleanupSidecarStaging(args.destinationCwd, mutation)
        applied.push(mutation)
        continue
      }
      if (mutation.kind === 'note') {
        const notes = await copyConversationNotebookBetweenCwds(
          args.sourceCwd,
          args.destinationCwd,
          mutationToken(mutation)
        )
        const copied: SidecarMutation | null =
          notes.copied && notes.relativePath && notes.entry && notes.sha256 && notes.mode !== undefined
            ? {
                path: notes.relativePath,
                kind: 'note',
                entry: notes.entry,
                created: true,
                afterSha256: notes.sha256,
                afterMode: notes.mode,
              }
            : null
        if (!copied || JSON.stringify(copied) !== JSON.stringify(mutation)) {
          throw new Error('Notes differ from the planned journal.')
        }
      } else if (mutation.kind === 'ignored') {
        await copySafeEntry(
          args.sourceCwd,
          args.destinationCwd,
          mutation.path,
          new Set(args.confirmedSensitivePaths).has(mutation.path),
          mutation
        )
      } else {
        throw new Error(`Unexpected sidecar during copying: ${mutation.path}`)
      }
      if (!(await mutationMatches(args.destinationCwd, mutation.path, mutation))) {
        throw new Error(`Sidecar ${mutation.path} could not be verified after copying.`)
      }
      applied.push(mutation)
    }
    return { mutations: plan.mutations, warnings: plan.warnings }
  } catch (error) {
    const rolledBack = await rollbackMigrationSidecars(args.destinationCwd, applied)
    if (!rolledBack) {
      throw new Error(`Sidecar copying failed and rollback requires manual recovery: ${String(error)}`)
    }
    throw error
  }
}
