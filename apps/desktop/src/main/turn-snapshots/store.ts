import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { APP_OWNED_EXCLUDES } from '../git-service'
import { emptyTemplateDir, snapshotGit, type SnapshotGitOptions, type SnapshotGitResult } from './git'

/**
 * Shadow stores: one bare Git directory per repository (shared by its worktrees) or per plain folder, under
 * `<userData>/turn-snapshots/stores/<key>`. A store keeps the trees captured at turn boundaries and one index per
 * working folder, which is only a stat cache of that folder. Nothing here ever writes inside a project: the store
 * reads the user's index (copied), the user's excludes, and, for read-only commands, the user's objects.
 */

export const STORE_VERSION = 1
export type StoreKind = 'git' | 'plain'

export interface StoreDirMeta {
  path: string
  lastUsedAt: number
  seeded?: boolean
  /** When a capture found too many new files; captures of the folder are skipped until it is cleared. */
  tooLargeAt?: number
}

export interface StoreMeta {
  version: typeof STORE_VERSION
  kind: StoreKind
  /** The repository's common Git directory, or the plain folder. */
  source: string
  /** The user's object directory, lent to read-only commands; null for plain folders. */
  alternate: string | null
  createdAt: number
  lastUsedAt: number
  dirs: Record<string, StoreDirMeta>
}

export class SnapshotUnavailableError extends Error {
  constructor(
    readonly reason: SnapshotUnavailableReason,
    message?: string
  ) {
    super(message ?? reason)
    this.name = 'SnapshotUnavailableError'
  }
}

export type SnapshotUnavailableReason =
  | 'disabled'
  | 'git-missing'
  | 'contains-profile'
  | 'not-a-directory'
  | 'too-many-files'
  | 'slow'
  | 'failed'

const PLAIN_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/']

export function storeExcludes(kind: StoreKind): string {
  return [
    '# Written by Maestrly for turn snapshots.',
    '.DS_Store',
    ...APP_OWNED_EXCLUDES,
    ...(kind === 'plain' ? PLAIN_EXCLUDES : []),
    '',
  ].join('\n')
}

/** Highest-precedence attributes: content is stored and restored byte for byte, whatever the project declares. */
export const STORE_ATTRIBUTES = '* -text -filter -ident -working-tree-encoding\n'

let rootDir: string | null = null

/** `<userData>/turn-snapshots`, set once at startup (and by tests). */
export function setTurnSnapshotsRoot(dir: string | null): void {
  rootDir = dir
  stores.clear()
  pendingStores.clear()
  discovery.clear()
  settingsCache.clear()
}

export function turnSnapshotsRoot(): string {
  if (!rootDir) throw new Error('Turn snapshots are not initialized')
  return rootDir
}

export function storesDir(): string {
  return path.join(turnSnapshotsRoot(), 'stores')
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Windows paths compare without case; elsewhere realpath already returns the stored spelling. */
function keyPath(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}

export function isInsidePath(parent: string, child: string): boolean {
  const rel = path.relative(keyPath(parent), keyPath(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export class ShadowStore {
  private tail: Promise<void> = Promise.resolve()

  constructor(
    readonly key: string,
    readonly gitDir: string,
    public meta: StoreMeta
  ) {}

  /** Serializes every operation on this store: captures, restores and collection never overlap. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  indexPath(dirKey: string): string {
    return path.join(this.gitDir, 'indexes', dirKey)
  }

  /** Commands that write objects, refs or an index. They never see the user's objects. */
  write(
    args: readonly string[],
    opts: Omit<SnapshotGitOptions, 'cwd' | 'gitDir' | 'alternate'> & { cwd?: string } = {}
  ): Promise<SnapshotGitResult> {
    return snapshotGit(args, { ...opts, cwd: opts.cwd ?? this.gitDir, gitDir: this.gitDir })
  }

  /** Commands that only read objects: diffs, tree listings, blob contents, reachability. */
  read(
    args: readonly string[],
    opts: Omit<SnapshotGitOptions, 'cwd' | 'gitDir' | 'alternate' | 'workTree' | 'index'> = {}
  ): Promise<SnapshotGitResult> {
    return snapshotGit(args, { ...opts, cwd: this.gitDir, gitDir: this.gitDir, alternate: this.meta.alternate })
  }

  async saveMeta(): Promise<void> {
    await writeJsonAtomic(path.join(this.gitDir, 'store.json'), this.meta)
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await fsp.writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
    await renameWithRetry(tmp, file)
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
  }
}

/** Windows reports a transient sharing violation while another process (an antivirus, an indexer) holds a file. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || attempt >= 5 || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? ''))
        throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

const stores = new Map<string, ShadowStore>()
const pendingStores = new Map<string, Promise<ShadowStore>>()

function readMeta(raw: string): StoreMeta | null {
  try {
    const value = JSON.parse(raw) as Partial<StoreMeta>
    if (value.version !== STORE_VERSION || (value.kind !== 'git' && value.kind !== 'plain')) return null
    if (typeof value.source !== 'string') return null
    return {
      version: STORE_VERSION,
      kind: value.kind,
      source: value.source,
      alternate: typeof value.alternate === 'string' ? value.alternate : null,
      createdAt: Number(value.createdAt) || Date.now(),
      lastUsedAt: Number(value.lastUsedAt) || Date.now(),
      dirs: value.dirs && typeof value.dirs === 'object' ? value.dirs : {},
    }
  } catch {
    return null
  }
}

async function createStore(gitDir: string, meta: StoreMeta): Promise<void> {
  const parent = path.dirname(gitDir)
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 })
  // Built aside and renamed into place, so an interrupted creation never leaves a half-made store.
  const tmp = path.join(parent, `.init-${Date.now()}-${randomUUID()}`)
  try {
    await snapshotGit(['init', '--bare', '--quiet', `--template=${emptyTemplateDir()}`, tmp], { cwd: parent })
    await fsp.mkdir(path.join(tmp, 'info'), { recursive: true })
    await fsp.mkdir(path.join(tmp, 'indexes'), { recursive: true })
    await fsp.writeFile(path.join(tmp, 'info', 'exclude'), storeExcludes(meta.kind))
    await fsp.writeFile(path.join(tmp, 'info', 'attributes'), STORE_ATTRIBUTES)
    await fsp.writeFile(path.join(tmp, 'store.json'), JSON.stringify(meta), { mode: 0o600 })
    await fsp.chmod(tmp, 0o700).catch(() => undefined)
    try {
      await renameWithRetry(tmp, gitDir)
    } catch (error) {
      if (!existsSync(path.join(gitDir, 'HEAD'))) throw error
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function openStore(key: string, kind: StoreKind, source: string, alternate: string | null): Promise<ShadowStore> {
  const cached = stores.get(key)
  if (cached) return cached
  const pending = pendingStores.get(key)
  if (pending) return pending
  const opening = (async () => {
    const gitDir = path.join(storesDir(), key)
    const now = Date.now()
    const fresh: StoreMeta = {
      version: STORE_VERSION,
      kind,
      source,
      alternate,
      createdAt: now,
      lastUsedAt: now,
      dirs: {},
    }
    if (!existsSync(path.join(gitDir, 'HEAD'))) await createStore(gitDir, fresh)
    const meta = readMeta(await fsp.readFile(path.join(gitDir, 'store.json'), 'utf8').catch(() => '')) ?? fresh
    // The repository may have moved its objects (a re-clone at the same path); the latest location wins.
    meta.alternate = alternate
    const store = new ShadowStore(key, gitDir, meta)
    // The excludes and attributes are ours: rewrite them so older stores follow the current rules.
    await fsp.mkdir(path.join(gitDir, 'info'), { recursive: true })
    await fsp.mkdir(path.join(gitDir, 'indexes'), { recursive: true })
    await fsp.writeFile(path.join(gitDir, 'info', 'exclude'), storeExcludes(meta.kind))
    await fsp.writeFile(path.join(gitDir, 'info', 'attributes'), STORE_ATTRIBUTES)
    stores.set(key, store)
    return store
  })()
  pendingStores.set(key, opening)
  try {
    return await opening
  } finally {
    pendingStores.delete(key)
  }
}

/** Every store opened in this process, for collection. */
export function openStores(): ShadowStore[] {
  return [...stores.values()]
}

/** Opens an existing store by key (collection walks the directory); null when it is not a store. */
export async function openExistingStore(key: string): Promise<ShadowStore | null> {
  const cached = stores.get(key)
  if (cached) return cached
  if (!/^[0-9a-f]{64}$/.test(key)) return null
  const gitDir = path.join(storesDir(), key)
  const meta = readMeta(await fsp.readFile(path.join(gitDir, 'store.json'), 'utf8').catch(() => ''))
  if (!meta || !existsSync(path.join(gitDir, 'HEAD'))) return null
  return openStore(key, meta.kind, meta.source, meta.alternate)
}

export function forgetStore(key: string): void {
  stores.delete(key)
}

interface UserRepository {
  topLevel: string
  gitDir: string
  commonDir: string
  index: string
}

const discovery = new Map<string, { at: number; value: Promise<UserRepository | null> }>()
const DISCOVERY_TTL_MS = 30_000

/** The repository whose top level is `dir`, read without the user's configuration; null for anything else. */
function discoverRepository(dir: string): Promise<UserRepository | null> {
  const cached = discovery.get(dir)
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value
  const value = (async () => {
    const result = await snapshotGit(
      [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-dir',
        '--git-common-dir',
        '--git-path',
        'index',
      ],
      { cwd: dir, timeoutMs: 15_000 }
    ).catch(() => null)
    const lines = result?.stdout.toString('utf8').split(/\r?\n/).filter(Boolean) ?? []
    if (lines.length < 4) return null
    const [topLevel, gitDir, commonDir, index] = lines as [string, string, string, string]
    try {
      const realTop = await fsp.realpath(topLevel)
      if (keyPath(realTop) !== keyPath(dir)) return null
      return { topLevel: realTop, gitDir: await fsp.realpath(gitDir), commonDir: await fsp.realpath(commonDir), index }
    } catch {
      return null
    }
  })()
  discovery.set(dir, { at: Date.now(), value })
  return value
}

export interface UserGitSettings {
  /** The user's own `core.excludesFile`, which this store's isolated configuration would not read. */
  excludesFile: string | null
}

const settingsCache = new Map<string, { at: number; value: Promise<UserGitSettings> }>()

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value
}

/** The settings of the user's own Git configuration that change which files a folder ignores. */
export function readUserGitSettings(dir: string): Promise<UserGitSettings> {
  const cached = settingsCache.get(dir)
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.value
  const value = (async () => {
    const result = await snapshotGit(['config', '--get', 'core.excludesFile'], {
      cwd: dir,
      userEnvironment: true,
      okCodes: [1],
      timeoutMs: 15_000,
    }).catch(() => null)
    const raw = result?.code === 0 ? result.stdout.toString('utf8').trim() : ''
    return { excludesFile: raw ? expandHome(raw) : null }
  })()
  settingsCache.set(dir, { at: Date.now(), value })
  return value
}

function flipCase(value: string): string {
  let out = ''
  for (const char of value) out += char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()
  return out
}

/** Whether names in `dir` match without case, probed on the folder itself so another volume gets its own answer. */
export async function isCaseInsensitive(dir: string): Promise<boolean> {
  let current = dir
  for (;;) {
    const base = path.basename(current)
    const flipped = flipCase(base)
    if (base && flipped !== base) {
      try {
        const [a, b] = await Promise.all([
          fsp.stat(current, { bigint: true }),
          fsp.stat(path.join(path.dirname(current), flipped), { bigint: true }),
        ])
        return a.ino === b.ino && a.dev === b.dev
      } catch {
        return false
      }
    }
    const parent = path.dirname(current)
    if (parent === current) return process.platform !== 'linux'
    current = parent
  }
}

export interface SnapshotDir {
  store: ShadowStore
  dirKey: string
  /** Real path of the folder. */
  workTree: string
  /** The user's repository at this folder's top level; null for a plain folder. */
  user: UserRepository | null
  /** `-c` entries for every command that scans the folder. */
  scanConfig: string[]
  /** The user's `info/exclude`, read where it is rather than copied. */
  excludeFrom: string | null
  settings: UserGitSettings
}

async function realFolder(cwd: string): Promise<string> {
  let workTree: string
  try {
    workTree = await fsp.realpath(cwd)
    if (!(await fsp.stat(workTree)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new SnapshotUnavailableError('not-a-directory')
  }
  const root = await fsp.realpath(turnSnapshotsRoot()).catch(() => turnSnapshotsRoot())
  // A folder holding the profile would snapshot the snapshots themselves.
  if (isInsidePath(workTree, root)) throw new SnapshotUnavailableError('contains-profile')
  return workTree
}

async function snapshotDir(store: ShadowStore, workTree: string, user: UserRepository | null): Promise<SnapshotDir> {
  const [settings, insensitive] = await Promise.all([readUserGitSettings(workTree), isCaseInsensitive(workTree)])
  const scanConfig = [`core.ignorecase=${insensitive ? 'true' : 'false'}`]
  if (settings.excludesFile && existsSync(settings.excludesFile))
    scanConfig.push(`core.excludesFile=${settings.excludesFile}`)
  const userExclude = user ? path.join(user.commonDir, 'info', 'exclude') : null
  return {
    store,
    dirKey: sha256(`dir\0${keyPath(workTree)}`),
    workTree,
    user,
    scanConfig,
    excludeFrom: userExclude && existsSync(userExclude) ? userExclude : null,
    settings,
  }
}

/** Resolves (creating it when needed) the store and index of the folder a conversation works in. */
export async function resolveSnapshotDir(cwd: string): Promise<SnapshotDir> {
  const workTree = await realFolder(cwd)
  const user = await discoverRepository(workTree)
  const kind: StoreKind = user ? 'git' : 'plain'
  const source = user ? user.commonDir : workTree
  const alternate = user ? path.join(user.commonDir, 'objects') : null
  const store = await openStore(sha256(`${kind}\0${keyPath(source)}`), kind, source, alternate)
  return snapshotDir(store, workTree, user)
}

/**
 * The folder of a recorded turn in the store that recorded it, even if the folder has since become (or stopped
 * being) a repository: later captures must compare against the same store's trees.
 */
export async function reopenSnapshotDir(storeKey: string, folder: string): Promise<SnapshotDir> {
  const workTree = await realFolder(folder)
  const store = await openExistingStore(storeKey)
  if (!store) throw new SnapshotUnavailableError('failed', 'The snapshot store no longer exists')
  const user = store.meta.kind === 'git' ? await discoverRepository(workTree) : null
  return snapshotDir(store, workTree, user && keyPath(user.commonDir) === keyPath(store.meta.source) ? user : null)
}
