import { promises as fsp, watch as fsWatch, type FSWatcher } from 'node:fs'
import * as windowIpc from '../window-ipc'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { getConversation, getLocale, listWorkspaces } from '../store'
import { tFor } from '../i18n'
import { excludeFromGitInfo } from '../git-service'
import { workspaceDataDir } from '../app-paths'

/**
 * Two-level nested Markdown notebooks. Each directory contains <id>.md pages and _pages.json metadata
 * (title, emoji, parentId, order); files are authoritative. Conversation notes live in
 * <cwd>/.agents/notes, project notes in userData/workspace-data/<id>/project-notes. Serialize writes
 * per file and use temporary-file rename; record writes to suppress echoes and watch external edits
 * for UI updates. Conversations sharing a local cwd also share notes; isolated worktrees do not.
 */

export type NotesScope = 'conv' | 'project'

export interface PageMeta {
  id: string
  title: string
  emoji?: string
  parentId: string | null
  order: number
}
interface Manifest {
  pages: PageMeta[]
}

const NOTES_DIR = '.agents'
const CONV_SUB = 'notes'
const PROJECT_SUB = 'project-notes'
const MANIFEST = '_pages.json'
const OLD_CONV_FILE = 'notes.md' // legacy single-page format for migration
const OLD_PROJECT_FILE = 'project-notes.md'

// Store note images in assets/<uuid>.<ext> with relative Markdown references, not base64, for file
// editing/export. Notes ignore rules cover assets; generate data URLs only when displaying under CSP.
const ASSETS_SUB = 'assets'
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // approximately 5 MB per image
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}
const EXT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}
const ASSET_REF_RE = /assets\/([^)\s"'<>]+)/g

export interface NotebookSnapshotEntry {
  path: string
  kind: 'file' | 'directory'
  size: number
  mode: number
  sha256?: string
}

export interface NotebookCopyResult {
  copied: boolean
  entries: NotebookSnapshotEntry[]
  relativePath?: string
  entry?: 'file' | 'directory'
  sha256?: string
  mode?: number
}

const lastWritten = new Map<string, string>() // path to last app-written content for echo suppression
const watchers = new Map<string, FSWatcher>() // notebook directory to watcher
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const routes = new Map<string, { scope: NotesScope; id: string }>() // notebook directory to scope
const locks = new Map<string, Promise<unknown>>() // path to serialized write queue

function noteTitle(key: 'notes' | 'untitled'): string {
  return tFor(getLocale(), 'ui')(`notes.${key}`)
}

// Per-file locks and atomic writes.

function withLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  locks.set(
    file,
    run.catch(() => {})
  )
  return run
}
async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${randomUUID()}` // unique per call to avoid concurrent rename races
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, file)
}

// Notebook directory handling.

/** Notebook directory, or null if conversation/workspace is missing. */
export function conversationNotebookDirAtCwd(cwd: string): string {
  return path.join(cwd, NOTES_DIR, CONV_SUB)
}

function notebookDir(scope: NotesScope, id: string): string | null {
  if (scope === 'conv') {
    const conv = getConversation(id)
    // Conversation notes follow cwd: external worktree or multi-repository aggregator.
    return conv ? conversationNotebookDirAtCwd(conv.cwd) : null
  }
  const ws = listWorkspaces().find((w) => w.id === id)
  // Project notes live in userData independently of workspace repository path (#143).
  return ws ? path.join(workspaceDataDir(id), PROJECT_SUB) : null
}

function notebookEntriesHash(entries: NotebookSnapshotEntry[], rootMode: number): string {
  const hash = createHash('sha256')
  hash.update(`d\0\0${rootMode}\0`)
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      hash.update(`d\0${entry.path}\0${entry.mode}\0`)
    } else {
      hash.update(`f\0${entry.path}\0${entry.mode}\0${entry.size}\0${entry.sha256 ?? ''}\0`)
    }
  }
  return hash.digest('hex')
}

function notebookFileHash(sha256: string, size: number, mode: number): string {
  return createHash('sha256').update(`f\0\0${mode}\0${size}\0${sha256}\0`).digest('hex')
}

async function notebookSnapshot(dir: string): Promise<NotebookSnapshotEntry[]> {
  const root = await fsp.lstat(dir)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('The notebook is not a regular directory.')
  const out: NotebookSnapshotEntry[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(current, entry.name)
      const stat = await fsp.lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error(`The notes contain a symlink: ${relative}`)
      if (stat.isDirectory()) {
        out.push({ path: relative, kind: 'directory', size: 0, mode: stat.mode & 0o7777 })
        await walk(absolute, relative)
      } else if (stat.isFile()) {
        const content = await fsp.readFile(absolute)
        out.push({
          path: relative,
          kind: 'file',
          size: content.byteLength,
          mode: stat.mode & 0o7777,
          sha256: createHash('sha256').update(content).digest('hex'),
        })
      } else {
        throw new Error(`The notes contain a special file: ${relative}`)
      }
    }
  }
  await walk(dir, '')
  return out
}

interface ConversationNotebookSnapshot {
  entries: NotebookSnapshotEntry[]
  rootMode: number
}

async function conversationNotebookSnapshotAtCwd(cwd: string): Promise<ConversationNotebookSnapshot | null> {
  const dir = conversationNotebookDirAtCwd(cwd)
  try {
    const [rootReal, dirReal, stat] = await Promise.all([fsp.realpath(cwd), fsp.realpath(dir), fsp.lstat(dir)])
    if (dirReal !== path.join(rootReal, NOTES_DIR, CONV_SUB)) {
      throw new Error('The notebook escapes cwd through a symlink/junction.')
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('The notebook is not a regular directory.')
    }
    return { entries: await notebookSnapshot(dir), rootMode: stat.mode & 0o7777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function snapshotConversationNotebookAtCwd(cwd: string): Promise<NotebookSnapshotEntry[] | null> {
  return (await conversationNotebookSnapshotAtCwd(cwd))?.entries ?? null
}

/** Plan a verifiable journal without touching destination; persist it before the first rename/link. */
export async function planConversationNotebookCopyAtCwd(cwd: string): Promise<NotebookCopyResult> {
  const snapshot = await conversationNotebookSnapshotAtCwd(cwd)
  if (snapshot) {
    return {
      copied: true,
      entries: snapshot.entries,
      relativePath: path.posix.join(NOTES_DIR, CONV_SUB),
      entry: 'directory',
      sha256: notebookEntriesHash(snapshot.entries, snapshot.rootMode),
      mode: snapshot.rootMode,
    }
  }
  const legacy = path.join(cwd, NOTES_DIR, OLD_CONV_FILE)
  try {
    const stat = await fsp.lstat(legacy)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The legacy notes file is not a regular file.')
    const [rootReal, legacyReal, content] = await Promise.all([
      fsp.realpath(cwd),
      fsp.realpath(legacy),
      fsp.readFile(legacy),
    ])
    if (legacyReal !== path.join(rootReal, NOTES_DIR, OLD_CONV_FILE)) {
      throw new Error('Legacy notes escape cwd through a symlink/junction.')
    }
    const mode = stat.mode & 0o7777
    const sha256 = createHash('sha256').update(content).digest('hex')
    return {
      copied: true,
      entries: [{ path: OLD_CONV_FILE, kind: 'file', size: content.byteLength, mode, sha256 }],
      relativePath: path.posix.join(NOTES_DIR, OLD_CONV_FILE),
      entry: 'file',
      sha256: notebookFileHash(sha256, content.byteLength, mode),
      mode,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { copied: false, entries: [] }
    throw error
  }
}

/** Copy the entire notebook through staging/rename and verify source content remained unchanged. */
async function ensureSafeNotebookDestinationParent(destinationCwd: string): Promise<string> {
  const root = path.resolve(destinationCwd)
  const rootStat = await fsp.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('The notes destination is not a regular directory.')
  }
  const rootReal = await fsp.realpath(root)
  const parent = path.join(root, NOTES_DIR)
  try {
    const stat = await fsp.lstat(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The notes destination is unsafe.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await fsp.mkdir(parent)
  }
  const parentReal = await fsp.realpath(parent)
  if (parentReal !== path.join(rootReal, NOTES_DIR)) throw new Error('The notes destination escapes the worktree.')
  return parent
}

async function assertSafeNotebookDestinationParent(destinationCwd: string, expectedParent: string): Promise<void> {
  const parent = await ensureSafeNotebookDestinationParent(destinationCwd)
  if (path.resolve(parent) !== path.resolve(expectedParent)) {
    throw new Error('The notes ancestor changed during migration.')
  }
}

async function quarantineInstalledLegacyNotebook(
  destinationCwd: string,
  destination: string,
  parent: string,
  stagingToken: string,
  expectedHash: string,
  expectedMode: number
): Promise<boolean> {
  let stat: Awaited<ReturnType<typeof fsp.lstat>>
  try {
    stat = await fsp.lstat(destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== expectedMode) return false
  const content = await fsp.readFile(destination)
  if (createHash('sha256').update(content).digest('hex') !== expectedHash) return false
  const quarantine = path.join(destinationCwd, `.notes-cleanup-${stagingToken}`)
  try {
    await fsp.lstat(quarantine)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await assertSafeNotebookDestinationParent(destinationCwd, parent)
  try {
    await fsp.rename(destination, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  // Quarantine is durable; do not destroy or overwrite-restore an inode that may still have an open writer.
  return false
}

export async function copyConversationNotebookBetweenCwds(
  sourceCwd: string,
  destinationCwd: string,
  stagingToken: string = randomUUID()
): Promise<NotebookCopyResult> {
  if (!/^[a-z0-9-]+$/i.test(stagingToken)) throw new Error('Invalid notes staging token.')
  const source = conversationNotebookDirAtCwd(sourceCwd)
  const destination = conversationNotebookDirAtCwd(destinationCwd)
  const sourceSnapshot = await conversationNotebookSnapshotAtCwd(sourceCwd)
  const before = sourceSnapshot?.entries ?? null
  if (!before) {
    const legacySource = path.join(sourceCwd, NOTES_DIR, OLD_CONV_FILE)
    const legacyDestination = path.join(destinationCwd, NOTES_DIR, OLD_CONV_FILE)
    try {
      const stat = await fsp.lstat(legacySource)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The legacy notes file is not a regular file.')
      const [sourceRootReal, legacyReal] = await Promise.all([fsp.realpath(sourceCwd), fsp.realpath(legacySource)])
      if (legacyReal !== path.join(sourceRootReal, NOTES_DIR, OLD_CONV_FILE)) {
        throw new Error('Legacy notes escape cwd through a symlink/junction.')
      }
      const content = await fsp.readFile(legacySource)
      const sourceHash = createHash('sha256').update(content).digest('hex')
      const parent = await ensureSafeNotebookDestinationParent(destinationCwd)
      try {
        await fsp.lstat(legacyDestination)
        throw new Error('The destination already contains legacy notes.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const staging = path.join(parent, `.legacy-notes-${stagingToken}`)
      let installed = false
      try {
        try {
          const stagedStat = await fsp.lstat(staging)
          if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
            throw new Error('Legacy notes staging is unsafe.')
          }
          const staged = await fsp.readFile(staging)
          if (
            (stagedStat.mode & 0o7777) !== (stat.mode & 0o7777) ||
            createHash('sha256').update(staged).digest('hex') !== sourceHash
          ) {
            throw new Error('Legacy notes staging differs from the journal.')
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await fsp.writeFile(staging, content, { mode: stat.mode & 0o7777, flag: 'wx' })
          await fsp.chmod(staging, stat.mode & 0o7777).catch(() => {})
        }
        const [sourceAfterStat, sourceAfter, staged] = await Promise.all([
          fsp.lstat(legacySource),
          fsp.readFile(legacySource),
          fsp.readFile(staging),
        ])
        if (
          !sourceAfterStat.isFile() ||
          sourceAfterStat.isSymbolicLink() ||
          createHash('sha256').update(sourceAfter).digest('hex') !== sourceHash ||
          createHash('sha256').update(staged).digest('hex') !== sourceHash
        ) {
          throw new Error('Legacy notes changed during copying.')
        }
        await assertSafeNotebookDestinationParent(destinationCwd, parent)
        await fsp.link(staging, legacyDestination)
        installed = true
        await fsp.rm(staging, { force: true }).catch(() => {})
      } catch (error) {
        if (
          installed &&
          !(await quarantineInstalledLegacyNotebook(
            destinationCwd,
            legacyDestination,
            parent,
            stagingToken,
            sourceHash,
            stat.mode & 0o7777
          ).catch(() => false))
        ) {
          throw new Error(`Installing legacy notes requires manual recovery: ${String(error)}`)
        }
        throw error
      }
      const mode = stat.mode & 0o7777
      return {
        copied: true,
        entries: [
          {
            path: OLD_CONV_FILE,
            kind: 'file',
            size: content.byteLength,
            mode,
            sha256: sourceHash,
          },
        ],
        relativePath: path.posix.join(NOTES_DIR, OLD_CONV_FILE),
        entry: 'file',
        sha256: notebookFileHash(sourceHash, content.byteLength, mode),
        mode,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { copied: false, entries: [] }
      throw error
    }
  }
  const sourceMode = sourceSnapshot!.rootMode
  try {
    await fsp.lstat(destination)
    throw new Error('The destination already contains a notebook.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const parent = await ensureSafeNotebookDestinationParent(destinationCwd)
  const staging = path.join(parent, `.notes-migration-${stagingToken}`)
  try {
    let stagingExists = false
    try {
      const [staged, stagedStat] = await Promise.all([notebookSnapshot(staging), fsp.lstat(staging)])
      if (
        !stagedStat.isDirectory() ||
        stagedStat.isSymbolicLink() ||
        (stagedStat.mode & 0o7777) !== sourceMode ||
        JSON.stringify(staged) !== JSON.stringify(before)
      ) {
        throw new Error('Notebook staging differs from the journal.')
      }
      stagingExists = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!stagingExists) {
      await fsp.mkdir(staging, { mode: sourceMode })
      await fsp.chmod(staging, sourceMode).catch(() => {})
      for (const entry of before) {
        const target = path.join(staging, ...entry.path.split('/'))
        if (entry.kind === 'directory') {
          await fsp.mkdir(target, { recursive: true, mode: entry.mode })
          await fsp.chmod(target, entry.mode).catch(() => {})
        } else {
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.copyFile(path.join(source, ...entry.path.split('/')), target)
          await fsp.chmod(target, entry.mode).catch(() => {})
        }
      }
    }
    const [sourceAfter, sourceAfterStat, staged, stagedStat] = await Promise.all([
      notebookSnapshot(source),
      fsp.lstat(source),
      notebookSnapshot(staging),
      fsp.lstat(staging),
    ])
    if (
      !sourceAfterStat.isDirectory() ||
      sourceAfterStat.isSymbolicLink() ||
      (sourceAfterStat.mode & 0o7777) !== sourceMode ||
      !stagedStat.isDirectory() ||
      stagedStat.isSymbolicLink() ||
      (stagedStat.mode & 0o7777) !== sourceMode ||
      JSON.stringify(sourceAfter) !== JSON.stringify(before) ||
      JSON.stringify(staged) !== JSON.stringify(before)
    ) {
      throw new Error('The notebook changed during copying.')
    }
    await assertSafeNotebookDestinationParent(destinationCwd, parent)
    await fsp.rename(staging, destination)
    return {
      copied: true,
      entries: before,
      relativePath: path.posix.join(NOTES_DIR, CONV_SUB),
      entry: 'directory',
      sha256: notebookEntriesHash(before, sourceMode),
      mode: sourceMode,
    }
  } catch (error) {
    // Leave deterministic staging on disk for resume/recovery; no compensation is needed here.
    throw error
  }
}

// One-time best-effort copy of legacy project-notes directory or single-page file into userData. Never
// overwrite existing destination content or modify the repository; migrateIfNeeded converts the copied
// legacy file afterward.
const reanchoredProject = new Set<string>()
async function migrateLegacyProjectNotes(workspaceId: string): Promise<void> {
  if (reanchoredProject.has(workspaceId)) return
  reanchoredProject.add(workspaceId)
  const ws = listWorkspaces().find((w) => w.id === workspaceId)
  if (!ws) return
  const base = workspaceDataDir(workspaceId)
  const legacyBase = path.join(ws.path, NOTES_DIR)
  for (const item of [PROJECT_SUB, OLD_PROJECT_FILE]) {
    const dest = path.join(base, item)
    try {
      await fsp.access(dest)
      continue // destination exists; do not overwrite
    } catch {
      /* Missing destination; try copying legacy content. */
    }
    await fsp.cp(path.join(legacyBase, item), dest, { recursive: true }).catch(() => {})
  }
}
const manifestPath = (dir: string) => path.join(dir, MANIFEST)
const pagePath = (dir: string, pageId: string) => path.join(dir, `${pageId}.md`)

/**
 * Validate pageId before constructing Markdown paths: reject empty, dot, dot-dot, and slash/backslash
 * traversal. Return null for safe caller no-op. Enforce in the service because both IPC and direct MCP
 * tools accept IDs; IPC-only checks would leave arbitrary-file read/write/delete paths (#264).
 */
export function safePageId(pageId: string): string | null {
  if (typeof pageId !== 'string') return null
  let name = ''
  try {
    name = decodeURIComponent(pageId)
  } catch {
    return null // invalid percent encoding
  }
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null
  return name
}

/**
 * Ensure directory, Git exclusions, single-page migration, and watcher; return the notebook directory
 * or null.
 */
async function ensureNotebook(scope: NotesScope, id: string): Promise<string | null> {
  if (scope === 'project') await migrateLegacyProjectNotes(id) // #143: re-ancora o legado in-repo → userData
  const dir = notebookDir(scope, id)
  if (!dir) return null
  await fsp.mkdir(dir, { recursive: true })
  // Apply conversation-note hygiene to cwd; project userData is not a Git repository, so exclusion is a
  // no-op there.
  await excludeFromGitInfo(path.dirname(path.dirname(dir)), [`${NOTES_DIR}/`])
  armWatch(dir, scope, id)
  await migrateIfNeeded(dir, scope, id)
  return dir
}

/**
 * Migrate a legacy single Markdown file into the first page or create a default page. Serialize under
 * the manifest lock and recheck to avoid duplicate migration/orphan files from concurrent list/read
 * calls.
 */
async function migrateIfNeeded(dir: string, scope: NotesScope, id: string): Promise<void> {
  const mf = manifestPath(dir)
  try {
    await fsp.access(mf)
    return // manifest already exists; lock-free fast path
  } catch {
    /* No manifest yet; migrate/create under lock. */
  }
  await withLock(mf, async () => {
    try {
      await fsp.access(mf)
      return // another concurrent call already migrated
    } catch {
      /* Continue. */
    }
    const oldName = scope === 'conv' ? OLD_CONV_FILE : OLD_PROJECT_FILE
    const oldFile = path.join(path.dirname(dir), oldName) // <base>/.agents/<legacy file>
    let content = ''
    try {
      content = await fsp.readFile(oldFile, 'utf8')
    } catch {
      /* No legacy file; create an empty page. */
    }
    const page: PageMeta = { id: randomUUID(), title: noteTitle('notes'), parentId: null, order: 0 }
    lastWritten.set(pagePath(dir, page.id), content)
    await atomicWrite(pagePath(dir, page.id), content)
    await saveManifest(dir, { pages: [page] })
    await fsp.rm(oldFile, { force: true }).catch(() => {})
    emitTree(scope, id, [page])
  })
}

async function loadManifest(dir: string): Promise<Manifest> {
  try {
    const raw = await fsp.readFile(manifestPath(dir), 'utf8')
    const m = JSON.parse(raw)
    if (!Array.isArray(m?.pages)) return { pages: [] }
    const pages = m.pages as PageMeta[]
    const ids = new Set<string>(pages.map((p) => p.id))
    // Move orphan pages with nonexistent parentId to the root so manually edited manifests cannot make them
    // invisible.
    for (const p of pages) if (p.parentId && !ids.has(p.parentId)) p.parentId = null
    // Densify sibling order while preserving relative order, handling sparse/colliding manually edited
    // values consistently.
    const groups = new Map<string | null, PageMeta[]>()
    for (const p of pages) (groups.get(p.parentId) ?? groups.set(p.parentId, []).get(p.parentId)!).push(p)
    for (const arr of groups.values()) arr.sort((a, b) => a.order - b.order).forEach((p, i) => (p.order = i))
    return { pages }
  } catch {
    return { pages: [] }
  }
}
async function saveManifest(dir: string, m: Manifest): Promise<void> {
  const raw = JSON.stringify(m, null, 2)
  lastWritten.set(manifestPath(dir), raw)
  await atomicWrite(manifestPath(dir), raw)
}

// Page API.

export async function listPages(scope: NotesScope, id: string): Promise<PageMeta[]> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return []
  return (await loadManifest(dir)).pages
}

export async function readPage(scope: NotesScope, id: string, pageId: string): Promise<string> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return ''
  if (!safePageId(pageId)) return '' // #264: reject traversal with a safe no-op
  try {
    return await fsp.readFile(pagePath(dir, pageId), 'utf8')
  } catch {
    return ''
  }
}

/** Read-only exported page metadata and Markdown content. */
export interface ExportedNotePage {
  id: string
  title: string
  emoji?: string
  parentId: string | null
  order: number
  content: string
}

/**
 * Read existing notebooks for export without ensureNotebook or any mkdir/migration/watch/write side
 * effects. Read manifest and Markdown files, or the legacy single-page file when no manifest exists.
 * Missing notebooks return null without creating default content (#263).
 */
export async function readNotebookReadOnly(scope: NotesScope, id: string): Promise<ExportedNotePage[] | null> {
  const dir = notebookDir(scope, id)
  if (!dir) return null
  let hasManifest = false
  try {
    await fsp.access(manifestPath(dir))
    hasManifest = true
  } catch {
    /* No manifest; try the legacy single-page format below. */
  }
  if (!hasManifest) {
    const oldName = scope === 'conv' ? OLD_CONV_FILE : OLD_PROJECT_FILE
    try {
      const content = await fsp.readFile(path.join(path.dirname(dir), oldName), 'utf8')
      return [{ id: 'legacy', title: noteTitle('notes'), parentId: null, order: 0, content }]
    } catch {
      return null // no manifest or legacy file means no notebook
    }
  }
  const pages = (await loadManifest(dir)).pages
  const out: ExportedNotePage[] = []
  for (const p of pages) {
    let content = ''
    try {
      content = await fsp.readFile(pagePath(dir, p.id), 'utf8')
    } catch {
      /* Missing page file yields empty content. */
    }
    out.push({ id: p.id, title: p.title, emoji: p.emoji, parentId: p.parentId, order: p.order, content })
  }
  return out
}

/**
 * External MCP/CLI writes immediately update UI; UI-origin writes suppress their own echo to preserve
 * editor focus/state.
 */
export async function writePage(
  scope: NotesScope,
  id: string,
  pageId: string,
  content: string,
  external = false
): Promise<void> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return
  if (!safePageId(pageId)) return // #264: prevent writes outside the notebook
  const file = pagePath(dir, pageId)
  await withLock(file, async () => {
    lastWritten.set(file, content)
    await atomicWrite(file, content)
  })
  emitPage(scope, id, pageId, content, external)
}

export async function appendPage(
  scope: NotesScope,
  id: string,
  pageId: string,
  text: string,
  external = false
): Promise<void> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return
  if (!safePageId(pageId)) return // #264: prevent writes outside the notebook
  const file = pagePath(dir, pageId)
  let result = ''
  await withLock(file, async () => {
    let cur = ''
    try {
      cur = await fsp.readFile(file, 'utf8')
    } catch {
      /* New page. */
    }
    result = cur.trim() ? `${cur.trimEnd()}\n\n${text}` : text
    lastWritten.set(file, result)
    await atomicWrite(file, result)
  })
  emitPage(scope, id, pageId, result, external)
}

// ---- imagens (assets) ----

export type UploadImageResult = { ok: true; relPath: string } | { ok: false; error: string }

/**
 * Persist a pasted/dropped image in notebook assets and return its relative Markdown path. Validate
 * MIME type and the 5 MB size limit.
 */
export async function uploadNoteImage(
  scope: NotesScope,
  id: string,
  mime: string,
  data: ArrayBuffer | Uint8Array
): Promise<UploadImageResult> {
  const ext = IMAGE_MIME_EXT[mime]
  if (!ext) return { ok: false, error: 'Unsupported format (use PNG, JPG, GIF, or WebP).' }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
  if (buf.byteLength === 0) return { ok: false, error: 'Imagem vazia.' }
  if (buf.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: 'Imagem maior que 5 MB.' }
  const dir = await ensureNotebook(scope, id)
  if (!dir) return { ok: false, error: 'Notebook not found.' }
  const assetsDir = path.join(dir, ASSETS_SUB)
  await fsp.mkdir(assetsDir, { recursive: true })
  const name = `${randomUUID()}.${ext}`
  await fsp.writeFile(path.join(assetsDir, name), buf)
  return { ok: true, relPath: `${ASSETS_SUB}/${name}` }
}

/**
 * Read an asset as a data URL for editor CSP. Validate paths from editable Markdown so access stays
 * within assets.
 */
export async function readNoteAsset(scope: NotesScope, id: string, relPath: string): Promise<string> {
  const dir = notebookDir(scope, id)
  if (!dir) return ''
  const assetsDir = path.resolve(dir, ASSETS_SUB)
  const resolved = path.resolve(dir, relPath)
  if (resolved !== assetsDir && !resolved.startsWith(assetsDir + path.sep)) return '' // outside assets/
  const mime = EXT_IMAGE_MIME[path.extname(resolved).slice(1).toLowerCase()]
  if (!mime) return ''
  try {
    const st = await fsp.lstat(resolved)
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_IMAGE_BYTES) return ''
    const buf = await fsp.readFile(resolved)
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return ''
  }
}

function parseAssetFileName(raw: string): string | null {
  let name = ''
  try {
    name = decodeURIComponent(raw)
  } catch {
    return null
  }
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null
  return name
}

function referencedAssetNames(content: string): Set<string> {
  const names = new Set<string>()
  for (const m of content.matchAll(ASSET_REF_RE)) {
    const name = parseAssetFileName(m[1])
    if (name) names.add(name)
  }
  return names
}

/**
 * Remove assets unreferenced by every current page after deletion. Preserve files younger than 60
 * seconds because their references may still be waiting in another page's save debounce.
 */
async function pruneOrphanAssets(dir: string): Promise<void> {
  const assetsDir = path.join(dir, ASSETS_SUB)
  let files: string[]
  try {
    files = await fsp.readdir(assetsDir)
  } catch {
    return // no assets directory; nothing to clean
  }
  if (files.length === 0) return
  const referenced = new Set<string>()
  for (const p of (await loadManifest(dir)).pages) {
    let content = ''
    try {
      content = await fsp.readFile(pagePath(dir, p.id), 'utf8')
    } catch {
      continue
    }
    for (const name of referencedAssetNames(content)) referenced.add(name)
  }
  const cutoff = Date.now() - 60_000
  await Promise.all(
    files
      .filter((f) => !referenced.has(f))
      .map(async (f) => {
        const file = path.join(assetsDir, f)
        try {
          if ((await fsp.stat(file)).mtimeMs > cutoff) return // recently written; a save may still be pending
          await fsp.rm(file, { force: true })
        } catch {
          /* Ignore missing or inaccessible files. */
        }
      })
  )
}

async function copyReferencedAssets(
  content: string,
  fromDir: string,
  toDir: string,
  copied: Map<string, string>
): Promise<string> {
  let result = content
  for (const m of content.matchAll(ASSET_REF_RE)) {
    const rawName = m[1]
    const name = parseAssetFileName(rawName)
    if (!name) continue
    let relPath = copied.get(name)
    if (!relPath) {
      const ext = path.extname(name).slice(1).toLowerCase()
      if (!EXT_IMAGE_MIME[ext]) continue
      const source = path.join(fromDir, ASSETS_SUB, name)
      try {
        const st = await fsp.lstat(source)
        if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_IMAGE_BYTES) continue
        const targetName = `${randomUUID()}.${ext === 'jpeg' ? 'jpg' : ext}`
        const targetDir = path.join(toDir, ASSETS_SUB)
        await fsp.mkdir(targetDir, { recursive: true })
        await fsp.copyFile(source, path.join(targetDir, targetName))
        relPath = `${ASSETS_SUB}/${targetName}`
        copied.set(name, relPath)
      } catch {
        continue
      }
    }
    result = result.split(`${ASSETS_SUB}/${rawName}`).join(relPath)
  }
  return result
}

export async function createPage(
  scope: NotesScope,
  id: string,
  args: { title?: string; parentId?: string | null; emoji?: string }
): Promise<PageMeta | null> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return null
  const parentId = args.parentId ?? null
  const page: PageMeta = {
    id: randomUUID(),
    title: args.title?.trim() || noteTitle('untitled'),
    emoji: args.emoji,
    parentId,
    order: 0,
  }
  await withLock(manifestPath(dir), async () => {
    const m = await loadManifest(dir)
    page.order = Math.max(-1, ...m.pages.filter((p) => p.parentId === parentId).map((p) => p.order)) + 1
    m.pages.push(page)
    await saveManifest(dir, m)
  })
  await writePageRaw(dir, page.id, '') // create an empty file without a page event
  emitTree(scope, id, (await loadManifest(dir)).pages)
  return page
}

async function writePageRaw(dir: string, pageId: string, content: string): Promise<void> {
  const file = pagePath(dir, pageId)
  await withLock(file, async () => {
    lastWritten.set(file, content)
    await atomicWrite(file, content)
  })
}

export async function renamePage(
  scope: NotesScope,
  id: string,
  pageId: string,
  patch: { title?: string; emoji?: string | null }
): Promise<void> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return
  await withLock(manifestPath(dir), async () => {
    const m = await loadManifest(dir)
    const p = m.pages.find((x) => x.id === pageId)
    if (!p) return
    if (patch.title !== undefined) p.title = patch.title.trim() || noteTitle('untitled')
    if (patch.emoji !== undefined) p.emoji = patch.emoji ?? undefined
    await saveManifest(dir, m)
  })
  emitTree(scope, id, (await loadManifest(dir)).pages)
}

/** Move/reorder a page without allowing it to become a descendant of itself. */
export async function movePage(
  scope: NotesScope,
  id: string,
  pageId: string,
  parentId: string | null,
  order: number
): Promise<void> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return
  await withLock(manifestPath(dir), async () => {
    const m = await loadManifest(dir)
    const p = m.pages.find((x) => x.id === pageId)
    if (!p) return
    if (parentId && (parentId === pageId || isDescendant(m.pages, parentId, pageId))) return // anti-ciclo
    const oldParent = p.parentId
    p.parentId = parentId
    // Insert at the destination sibling index and densify ordering.
    const dest = m.pages.filter((x) => x.parentId === parentId && x.id !== pageId).sort((a, b) => a.order - b.order)
    dest.splice(Math.max(0, Math.min(order, dest.length)), 0, p)
    dest.forEach((x, i) => (x.order = i))
    // Close the ordering gap among source siblings when reparenting.
    if (oldParent !== parentId) {
      m.pages
        .filter((x) => x.parentId === oldParent)
        .sort((a, b) => a.order - b.order)
        .forEach((x, i) => (x.order = i))
    }
    await saveManifest(dir, m)
  })
  emitTree(scope, id, (await loadManifest(dir)).pages)
}

/** Delete a page subtree; recreate a default page if the notebook becomes empty. */
export async function deletePage(scope: NotesScope, id: string, pageId: string): Promise<void> {
  const dir = await ensureNotebook(scope, id)
  if (!dir) return
  if (!safePageId(pageId)) return // #264: prevent constructing deletion paths outside the notebook
  await withLock(manifestPath(dir), async () => {
    const m = await loadManifest(dir)
    const removed = subtreeIds(m.pages, pageId)
    m.pages = m.pages.filter((p) => !removed.includes(p.id))
    if (m.pages.length === 0) m.pages.push({ id: randomUUID(), title: noteTitle('notes'), parentId: null, order: 0 })
    await saveManifest(dir, m)
    // Delete Markdown files under the lock so no writer recreates a page between manifest and file removal.
    for (const rid of removed) {
      lastWritten.delete(pagePath(dir, rid))
      await fsp.rm(pagePath(dir, rid), { force: true }).catch(() => {})
    }
  })
  emitTree(scope, id, (await loadManifest(dir)).pages)
  await pruneOrphanAssets(dir) // remove assets used only by deleted pages
}

/** Copy a conversation notebook subtree beneath a new conversation/date page in project notes. */
export async function mergeConvIntoProject(convId: string): Promise<{ ok: boolean; message: string }> {
  const conv = getConversation(convId)
  if (!conv) return { ok: false, message: 'Conversation not found.' }
  const convDir = await ensureNotebook('conv', convId)
  if (!convDir) return { ok: false, message: 'Conversation not found.' }
  const convPages = (await loadManifest(convDir)).pages
  if (convPages.length === 0) return { ok: false, message: 'This conversation has no pages.' }
  const projDir = await ensureNotebook('project', conv.workspaceId)
  if (!projDir) return { ok: false, message: 'Project not found.' }
  const date = new Date().toISOString().slice(0, 10)

  // Create the import root and map old page IDs to new IDs to rebuild hierarchy.
  const rootId = randomUUID()
  const newIds = new Map<string, string>()
  const newPages: PageMeta[] = [{ id: rootId, title: `${conv.name} — ${date}`, parentId: null, order: 0 }]
  const ordered = [...convPages].sort((a, b) => a.order - b.order)
  for (const p of ordered) newIds.set(p.id, randomUUID())
  ordered.forEach((p, i) => {
    newPages.push({
      id: newIds.get(p.id)!,
      title: p.title,
      emoji: p.emoji,
      parentId: p.parentId ? (newIds.get(p.parentId) ?? rootId) : rootId,
      order: p.order ?? i,
    })
  })

  await withLock(manifestPath(projDir), async () => {
    const m = await loadManifest(projDir)
    const baseOrder = Math.max(-1, ...m.pages.filter((p) => p.parentId === null).map((p) => p.order)) + 1
    newPages[0].order = baseOrder
    m.pages.push(...newPages)
    await saveManifest(projDir, m)
  })
  // Imported page content.
  const copiedAssets = new Map<string, string>()
  for (const p of ordered) {
    const content = await readPage('conv', convId, p.id)
    await writePageRaw(projDir, newIds.get(p.id)!, await copyReferencedAssets(content, convDir, projDir, copiedAssets))
  }
  await writePageRaw(projDir, rootId, '') // import root is only a container
  emitTree('project', conv.workspaceId, (await loadManifest(projDir)).pages)
  return { ok: true, message: `Imported into the project as "${conv.name} — ${date}".` }
}

// Tree helpers.

function childrenOf(pages: PageMeta[], parentId: string): PageMeta[] {
  return pages.filter((p) => p.parentId === parentId)
}
function subtreeIds(pages: PageMeta[], rootId: string): string[] {
  const out = [rootId]
  for (const c of childrenOf(pages, rootId)) out.push(...subtreeIds(pages, c.id))
  return out
}
/** Whether maybeChild descends from ancestor, preventing cyclic reparenting. */
function isDescendant(pages: PageMeta[], maybeChild: string, ancestor: string): boolean {
  return subtreeIds(pages, ancestor).includes(maybeChild)
}

// ---- emit ----

// Conversation updates target App and the corresponding notes panel. Project updates remain global because
// their panel lives in the main renderer. Fallback supports older harnesses.
function emitNotesState(scope: NotesScope, id: string, payload: unknown): void {
  if (scope === 'conv' && typeof windowIpc.sendToConversation === 'function') {
    windowIpc.sendToConversation(id, 'drawer:notes-state', payload, { panel: 'notes' })
  } else {
    windowIpc.broadcast('drawer:notes-state', payload)
  }
}

function emitTree(scope: NotesScope, id: string, pages: PageMeta[]): void {
  emitNotesState(scope, id, { type: 'tree', scope, id, pages })
}
function emitPage(scope: NotesScope, id: string, pageId: string, content: string, external: boolean): void {
  emitNotesState(scope, id, { type: 'page', scope, id, pageId, content, external })
}

// Directory watching.

function armWatch(dir: string, scope: NotesScope, id: string): void {
  routes.set(dir, { scope, id })
  if (watchers.has(dir)) return
  let w: FSWatcher
  try {
    w = fsWatch(dir, (_event, changed) => {
      if (!changed || changed.includes('.tmp-')) return // ignore atomicWrite temporary files
      const file = path.join(dir, changed)
      const prev = debounceTimers.get(file)
      if (prev) clearTimeout(prev)
      debounceTimers.set(
        file,
        setTimeout(() => onExternalChange(dir, changed), 250)
      )
    })
  } catch {
    return
  }
  watchers.set(dir, w)
}

async function onExternalChange(dir: string, changed: string): Promise<void> {
  const file = path.join(dir, changed)
  debounceTimers.delete(file)
  const r = routes.get(dir)
  if (!r) return
  if (changed === MANIFEST) {
    let raw = ''
    try {
      raw = await fsp.readFile(file, 'utf8')
    } catch {
      return
    }
    if (raw === lastWritten.get(file)) return // Ignore the echo of our own write.
    lastWritten.set(file, raw)
    try {
      emitTree(r.scope, r.id, (JSON.parse(raw) as Manifest).pages ?? [])
    } catch {
      /* Manifest may be temporarily invalid during external writes. */
    }
    return
  }
  if (!changed.endsWith('.md')) return
  let content = ''
  try {
    content = await fsp.readFile(file, 'utf8')
  } catch {
    return // page removed
  }
  if (content === lastWritten.get(file)) return // Ignore the echo of our own write.
  lastWritten.set(file, content)
  emitPage(r.scope, r.id, changed.slice(0, -3), content, true)
}

// ---- cleanup ----

function unwatchDir(dir: string): void {
  watchers.get(dir)?.close()
  watchers.delete(dir)
  routes.delete(dir)
  for (const k of [...debounceTimers.keys()]) {
    if (k.startsWith(dir + path.sep)) {
      clearTimeout(debounceTimers.get(k)!)
      debounceTimers.delete(k)
    }
  }
  for (const k of [...lastWritten.keys()]) if (k.startsWith(dir + path.sep)) lastWritten.delete(k)
  for (const k of [...locks.keys()]) if (k.startsWith(dir + path.sep)) locks.delete(k)
}

/** Stop watching the old notebook location before changing conversations.cwd. */
export function unwatchNotesAtCwd(cwd: string): void {
  unwatchDir(path.join(cwd, NOTES_DIR, CONV_SUB))
}

/** Stop conversation-note watching before deleting its row or archiving. */
export async function unwatchNotes(convId: string): Promise<void> {
  const dir = notebookDir('conv', convId)
  if (dir) unwatchDir(dir)
}
/** Stop project-note watching before removing the workspace row. */
export async function unwatchProject(workspaceId: string): Promise<void> {
  const dir = notebookDir('project', workspaceId)
  if (dir) unwatchDir(dir)
}
export function disposeNotes(): void {
  for (const w of watchers.values()) w.close()
  watchers.clear()
  for (const t of debounceTimers.values()) clearTimeout(t)
  debounceTimers.clear()
  routes.clear()
  lastWritten.clear()
  locks.clear()
}
