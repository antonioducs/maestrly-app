import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { type Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createZstdCompress, createZstdDecompress } from 'node:zlib'
import {
  FLEET_BOT_MOVE_LIMITS,
  fleetBotMoveDigestSchema,
  fleetInstanceProfileSchema,
  type FleetBotMoveDigest,
} from '@maestrly/bot-fleet-protocol'
import tar from 'tar-stream'
import { z } from 'zod'
import { standaloneConversationRelPath } from '../../app-paths'
import { attachmentConversationDir } from '../../chat/attachment-artifacts'
import { generatedImageConversationDir } from '../../chat/generated-images'
import { messagesDigest } from '../../conversation-move/digest'
import { MoveError } from '../../conversation-move/errors'
import {
  deleteImportedConversationRows,
  insertStandaloneConversationRows,
  readConversationRows,
  type MoveRows,
} from '../../conversation-move/rows'
import { botMemorySpaceId } from '../../memory/spaces'
import { realFs } from '../../real-fs'
import { deleteLocalMemorySpace, getConversation, getDb, transaction } from '../../store'
import { hashFile } from '../../transfer-io'
import { readRunRecords, type LaneRecord } from './routine-runs'
import {
  assertBotId,
  botPaths,
  deleteBotSettings,
  readBotPaused,
  readStoredProfile,
  removeBotFolder,
  writeBotPaused,
  writeStoredProfile,
} from './registry'
import { InstanceHttpError } from './server'

// A bot's files are plain files, whatever their names: its working folder may hold a `*.asar` one (an installed
// `electron` package ships `default_app.asar`), which `node:fs` in Electron would take for an archive.
const { constants: fsConstants, createReadStream, createWriteStream } = realFs
const {
  chmod,
  copyFile,
  link: hardLink,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} = realFs.promises

/**
 * Moving a bot to another environment of its server: everything that is the bot's own leaves in one package, a
 * zstd-compressed tar whose first entry is a manifest declaring every other entry by size and SHA-256, and arrives
 * whole or not at all. What the environment shares (accounts, skills, MCP servers, site logins, the home folder) stays.
 */
export const BOT_MOVE_PACKAGE_FORMAT = 'maestrly-bot-move'
export const BOT_MOVE_PACKAGE_VERSION = 1

/** The data folder and the home folder of an environment, where a bot's folders live. */
export interface BotRoots {
  userData: string
  home: string
}
export type BotFolderKind = 'state' | 'inputs' | 'images' | 'browser' | 'cache'
/** One of a bot's own folders, `<base>/<segments…>/<botId>`. */
export interface BotFolder {
  kind: BotFolderKind
  base: keyof BotRoots
  segments: readonly string[]
  /** Whether it moves with the bot; a purge deletes every folder, moving or not. */
  moves: boolean
}
/** A bot's folders, as `botPaths` names them: what a purge deletes and, but for the cache, what a move carries. */
export const BOT_FOLDERS: readonly BotFolder[] = [
  // Its queue, transcript extras and published files.
  { kind: 'state', base: 'userData', segments: ['fleet-instance', 'bots'], moves: true },
  { kind: 'inputs', base: 'userData', segments: ['fleet-inputs'], moves: true },
  { kind: 'images', base: 'userData', segments: ['fleet-images'], moves: true },
  // Its browser profile, with its site logins.
  { kind: 'browser', base: 'home', segments: ['.config', 'maestrly-bots'], moves: true },
  // Its session bus, sockets and wallpaper, which the environment it runs in makes again.
  { kind: 'cache', base: 'home', segments: ['.cache', 'maestrly-bots'], moves: false },
]
export const botFolderPath = (folder: BotFolder, roots: BotRoots, botId: string): string =>
  path.join(roots[folder.base], ...folder.segments, assertBotId(botId))

/**
 * The kinds of files a package carries: the bot's folders, its conversation's working folder and files, and the files
 * of its routine runs' conversations (`<conversation id>/<file>`), which work in that same folder.
 */
export type BotMoveFileKind =
  | Exclude<BotFolderKind, 'cache'>
  | 'workdir'
  | 'attachment'
  | 'generated-image'
  | 'run-attachment'
  | 'run-generated-image'
const FILE_KINDS: readonly BotMoveFileKind[] = [
  'state',
  'inputs',
  'images',
  'browser',
  'workdir',
  'attachment',
  'generated-image',
  'run-attachment',
  'run-generated-image',
]
/** Folders of a browser profile that Chromium fills again by itself: they never move. */
const BROWSER_CACHES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'component_crx_cache',
  'Crashpad',
])

interface Source {
  kind: BotMoveFileKind
  relative: string
  absolute: string
}
interface Entry {
  path: string
  kind: BotMoveFileKind
  relative: string
  size: number
  sha256: string
  mode: number
}
type Row = Record<string, unknown>
/** What a package carries besides files: the bot's settings, its conversation's rows and its memory space. */
export interface BotMoveRows {
  stored: { profile: unknown; primaryConversationId: string | null }
  paused: boolean
  conversation: MoveRows | null
  /** Its routine runs' conversations, with where memory extraction reached in each. */
  runs?: Array<{ runId: string; conversation: MoveRows; extraction: Row | null }>
  memories: Row[]
  /** Where memory extraction reached in its conversation, and the consolidation state of its memory space. */
  extraction: Row | null
  consolidation: Row | null
}

/** A standalone chat's id, as its managed folder is named (`standaloneConversationRelPath`). */
const conversationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const invalid = (message: string): InstanceHttpError => new InstanceHttpError(400, 'INVALID_REQUEST', message)
/** Devices know this refusal by its exact text: it says files, but the limit is the bytes of the package. */
const tooLarge = (): InstanceHttpError => new InstanceHttpError(409, 'CONFLICT', 'This bot has too many files to move.')
/** How many files a move reads or places at once: a bot's folder may hold tens of thousands of small ones. */
const FILE_CONCURRENCY = 16
/** Runs `task` on each item, `limit` at a time, answering in their order; the first failure stops the rest. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        out[index] = await task(items[index], index)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** What the app leaves while it writes a file of its own folders; such a file never moves. */
const isPartial = (name: string): boolean => name.endsWith('.tmp') || name.endsWith('.partial')
/** The app's own folders leave out partial files; a working folder moves whole. */
const skipPartial = (name: string, directory: boolean): boolean => !directory && isPartial(name)
const skipNothing = (): boolean => false

/**
 * A path inside one of the bot's folders: relative, with no empty, `.` or `..` segment, backslash or NUL. A bot carries
 * its working folder whole, its Git folders too, where a conversation moving between computers takes its repository
 * as a bundle and refuses `.git` among its files.
 */
function packageRelative(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\\') || path.posix.isAbsolute(raw))
    return null
  return raw.split('/').some((segment) => !segment || segment === '.' || segment === '..') ? null : raw
}
const within = (root: string, target: string): boolean => target === root || target.startsWith(root + path.sep)

/**
 * A symbolic link of a bot's working folder: it moves as a link. A relative one keeps its target as written; an
 * absolute one (`rooted`) keeps it relative to the working folder, and leads into that folder where the bot arrives.
 */
interface Link {
  relative: string
  target: string
  rooted: boolean
}
/**
 * A link of the working folder `root` (a real path) that moves: one that leads inside it, as written and, when it
 * leads somewhere, as resolved. One that leads out (to another conversation, or a file of the environment) stays: its
 * target does not move, and where the bot arrives it would lead to that environment's files.
 */
async function insideLink(root: string, relative: string): Promise<Link | null> {
  const absolute = path.join(root, relative)
  const target = await readlink(absolute).catch(() => null)
  if (!target || target.length > 4096) return null
  const resolved = path.resolve(path.dirname(absolute), target)
  if (!within(root, resolved)) return null
  const real = await realpath(absolute).catch(() => null)
  if (real !== null && !within(root, real)) return null
  return path.isAbsolute(target)
    ? { relative, target: path.relative(root, resolved).split(path.sep).join('/'), rooted: true }
    : { relative, target, rooted: false }
}
/** What a link reads where its working folder is `root`. */
const linkText = (root: string, link: Link): string => (link.rooted ? path.join(root, link.target) : link.target)

/**
 * The regular files, symbolic links and folders under `dir`, relative to it, in a stable order; other special files
 * never move. `skip` leaves files and folders out by name.
 */
async function walk(
  dir: string,
  prefix: string,
  skip: (name: string, directory: boolean) => boolean,
  out: { files: string[]; links: string[]; directories: string[] } = { files: [], links: [], directories: [] }
): Promise<{ files: string[]; links: string[]; directories: string[] }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  })
  if (!entries) return out
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip(entry.name, entry.isDirectory())) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isFile()) out.files.push(relative)
    else if (entry.isSymbolicLink()) out.links.push(relative)
    else if (entry.isDirectory()) {
      out.directories.push(relative)
      await walk(path.join(dir, entry.name), relative, skip, out)
    }
  }
  return out
}

/** The folder a bot's conversation works in here: inside this data folder, by the conversation's id. */
async function workdirOf(roots: BotRoots, conversationId: string): Promise<string> {
  return standaloneConversationRelPath(await realpath(roots.userData), conversationId)
}

/** The conversation a bot's settings name, when it is here. */
function conversationOf(botId: string): string | null {
  const id = readStoredProfile(botId)?.primaryConversationId ?? null
  return id && getConversation(id) ? id : null
}

/** The side conversations of a bot (routine runs and threads) whose conversations are here, as the bot keeps them. */
async function runsOf(botId: string, roots: BotRoots): Promise<LaneRecord[]> {
  const records = await readRunRecords(botPaths(roots.userData, roots.home, botId))
  return records.filter((record) => getConversation(record.conversationId))
}

function extractionRow(conversationId: string): Row | null {
  return (
    (getDb().prepare('SELECT * FROM memory_extraction_state WHERE conversation_id = ?').get(conversationId) as
      | Row
      | undefined) ?? null
  )
}

/** Everything that moves with a bot, from where it is now: its files, and the links of its working folder. */
interface Sources {
  files: Source[]
  links: Link[]
  /** The working folder's folders, empty ones too: a Git repository needs its empty `objects` and `refs`. */
  directories: string[]
}
async function collectSources(botId: string, roots: BotRoots): Promise<Sources> {
  const files: Source[] = []
  const links: Link[] = []
  let directories: string[] = []
  for (const folder of BOT_FOLDERS) {
    if (!folder.moves) continue
    const dir = botFolderPath(folder, roots, botId)
    const skip =
      folder.kind === 'browser'
        ? (name: string, directory: boolean) => BROWSER_CACHES.has(name) || skipPartial(name, directory)
        : skipPartial
    for (const relative of (await walk(dir, '', skip)).files)
      files.push({ kind: folder.kind as BotMoveFileKind, relative, absolute: path.join(dir, relative) })
  }
  const conversationId = conversationOf(botId)
  if (conversationId) {
    const workdir = await workdirOf(roots, conversationId)
    const found = await walk(workdir, '', skipNothing)
    directories = found.directories
    for (const relative of found.files)
      files.push({ kind: 'workdir', relative, absolute: path.join(workdir, relative) })
    for (const relative of found.links) {
      const link = await insideLink(workdir, relative)
      if (link) links.push(link)
    }
    const folders: Array<[BotMoveFileKind, string]> = [
      ['attachment', attachmentConversationDir(conversationId)],
      ['generated-image', generatedImageConversationDir(conversationId)],
    ]
    for (const [kind, dir] of folders)
      for (const relative of (await walk(dir, '', skipPartial)).files)
        files.push({ kind, relative, absolute: path.join(dir, relative) })
    for (const run of await runsOf(botId, roots)) {
      const runFolders: Array<[BotMoveFileKind, string]> = [
        ['run-attachment', attachmentConversationDir(run.conversationId)],
        ['run-generated-image', generatedImageConversationDir(run.conversationId)],
      ]
      for (const [kind, dir] of runFolders)
        for (const relative of (await walk(dir, run.conversationId, skipPartial)).files)
          files.push({ kind, relative, absolute: path.join(dir, relative.slice(run.conversationId.length + 1)) })
    }
  }
  return { files, links, directories }
}

function memoryRows(botId: string): Row[] {
  return getDb()
    .prepare('SELECT * FROM local_memories WHERE workspace_id = ? ORDER BY created_at, id')
    .all(botMemorySpaceId(botId)) as Row[]
}
function memoriesDigest(botId: string): { memories: number; memoriesSha256: string } {
  const rows = memoryRows(botId)
  const hash = createHash('sha256')
  for (const row of [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))))
    hash.update(
      `${JSON.stringify([row.id, row.title, row.content, row.type, row.status, row.pinned, row.source, row.supersedes_id, row.content_hash, row.created_at, row.updated_at])}\n`
    )
  return { memories: rows.length, memoriesSha256: hash.digest('hex') }
}
/** The bot's files and links in one hash; `hashes` holds the SHA-256 of the files when they were just read. */
async function filesDigest(
  sources: Sources,
  hashes?: readonly string[]
): Promise<{ files: number; filesSha256: string }> {
  const read = hashes ?? (await mapLimit(sources.files, FILE_CONCURRENCY, (source) => hashFile(source.absolute)))
  const lines = sources.files.map((source, index) => `${source.kind}/${source.relative}:${read[index]}`)
  for (const link of sources.links) lines.push(`link:${JSON.stringify([link.relative, link.target, link.rooted])}`)
  for (const directory of sources.directories) lines.push(`directory:${JSON.stringify(directory)}`)
  lines.sort()
  return { files: lines.length, filesSha256: createHash('sha256').update(lines.join('\n')).digest('hex') }
}

/**
 * What this environment holds of a bot, reduced to counts and hashes: the environment it leaves computes it when it
 * freezes the bot, the one it joins once it imported it, and both must agree. A package being written passes what it
 * read, so its files are not read once more.
 */
export async function botMoveDigest(
  botId: string,
  roots: BotRoots,
  read?: { sources: Sources; hashes: readonly string[] }
): Promise<FleetBotMoveDigest> {
  const conversationId = conversationOf(botId)
  let messages = conversationId
    ? messagesDigest(conversationId)
    : { conversationId: null, messages: 0, lastSeq: -1, messagesSha256: createHash('sha256').digest('hex') }
  // Its routine runs' messages count too, folded into the one hash in the order of their conversations' ids.
  const runs = conversationId
    ? (await runsOf(botId, roots))
        .map((run) => messagesDigest(run.conversationId))
        .sort((a, b) => a.conversationId.localeCompare(b.conversationId))
    : []
  if (runs.length)
    messages = {
      ...messages,
      messages: messages.messages + runs.reduce((sum, run) => sum + run.messages, 0),
      messagesSha256: createHash('sha256')
        .update(
          [messages.messagesSha256, ...runs.map((run) => `${run.conversationId}:${run.messagesSha256}`)].join('\n')
        )
        .digest('hex'),
    }
  return fleetBotMoveDigestSchema.parse({
    ...messages,
    ...memoriesDigest(botId),
    ...(await filesDigest(read?.sources ?? (await collectSources(botId, roots)), read?.hashes)),
  })
}

const sha = z.string().regex(/^[0-9a-f]{64}$/)
const count = z.number().int().nonnegative()
const manifestSchema = z.object({
  format: z.literal(BOT_MOVE_PACKAGE_FORMAT),
  version: z.literal(BOT_MOVE_PACKAGE_VERSION),
  appVersion: z.string().min(1).max(100),
  botId: z.string(),
  createdAt: count,
  digest: fleetBotMoveDigestSchema,
  rows: z.object({ size: count.max(1024 ** 3), sha256: sha }),
  entries: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(FILE_KINDS as [BotMoveFileKind, ...BotMoveFileKind[]]),
      relative: z.string(),
      size: count,
      sha256: sha,
      mode: z.number().int().min(0).max(0o7777),
    })
  ),
  /** The links of the working folder, made once its files are in place. */
  links: z.array(z.object({ relative: z.string(), target: z.string().max(4096), rooted: z.boolean() })),
  /** The folders of the working folder, made before its files, so that the empty ones move too. */
  directories: z.array(z.string()),
})
type Manifest = z.infer<typeof manifestSchema>
const MANIFEST = 'manifest.json'
const ROWS = 'rows.json'
const entryPath = (kind: BotMoveFileKind, relative: string): string => `files/${kind}/${relative}`

/**
 * Refuses a move whose files already take more than a package may carry, before the bot is frozen: their sizes are
 * cheap to read, while freezing hashes every one of them. The bot still runs, so a file that went meanwhile counts as
 * nothing; the package checks its own total, rows included, when it is written.
 */
export async function assertBotFitsMove(botId: string, roots: BotRoots): Promise<void> {
  const sources = await collectSources(botId, roots)
  const sizes = await mapLimit(
    sources.files,
    FILE_CONCURRENCY,
    async (source) => (await lstat(source.absolute).catch(() => null))?.size ?? 0
  )
  if (sizes.reduce((sum, size) => sum + size, 0) > FLEET_BOT_MOVE_LIMITS.packageMaxBytes) throw tooLarge()
}

/**
 * Packs a frozen bot into `destination`: its settings, its conversation's rows and files, its memory space and its
 * folders. Answers the package's size and SHA-256 with the digest of what it holds.
 */
export async function writeBotPackage(
  botId: string,
  roots: BotRoots,
  destination: string,
  appVersion: string
): Promise<{ size: number; sha256: string; digest: FleetBotMoveDigest }> {
  const stored = readStoredProfile(botId)
  if (!stored) throw new InstanceHttpError(404, 'NOT_FOUND', 'Bot does not exist.')
  const conversationId = conversationOf(botId)
  const rows: BotMoveRows = {
    // A conversation that is gone is not named: the bot starts a new one where it arrives.
    stored: { profile: stored.profile, primaryConversationId: conversationId },
    paused: readBotPaused(botId),
    conversation: conversationId ? readConversationRows(conversationId) : null,
    runs: conversationId
      ? (await runsOf(botId, roots)).map((run) => ({
          runId: run.runId,
          conversation: readConversationRows(run.conversationId),
          extraction: extractionRow(run.conversationId),
        }))
      : [],
    memories: memoryRows(botId),
    extraction: conversationId ? extractionRow(conversationId) : null,
    consolidation:
      (getDb().prepare('SELECT * FROM memory_consolidation_state WHERE space_id = ?').get(botMemorySpaceId(botId)) as
        | Row
        | undefined) ?? null,
  }
  const rowsBytes = Buffer.from(JSON.stringify(rows))
  const sources = await collectSources(botId, roots)
  for (const item of [...sources.files, ...sources.links])
    if (!packageRelative(item.relative)) throw invalid(`Unsafe package path: ${item.relative}`)
  const infos = await mapLimit(sources.files, FILE_CONCURRENCY, async (source) => {
    const info = await lstat(source.absolute)
    if (!info.isFile()) throw invalid('A file of the bot changed while it was packed.')
    return info
  })
  // Sizes first: a bot too large to move is refused before any of its files is read.
  if (infos.reduce((sum, info) => sum + info.size, rowsBytes.length) > FLEET_BOT_MOVE_LIMITS.packageMaxBytes)
    throw tooLarge()
  const entries = await mapLimit(
    sources.files,
    FILE_CONCURRENCY,
    async (source, index): Promise<Entry> => ({
      path: entryPath(source.kind, source.relative),
      kind: source.kind,
      relative: source.relative,
      size: infos[index].size,
      sha256: await hashFile(source.absolute),
      mode: infos[index].mode & 0o777,
    })
  )
  const digest = await botMoveDigest(botId, roots, { sources, hashes: entries.map((entry) => entry.sha256) })
  const manifest: Manifest = {
    format: BOT_MOVE_PACKAGE_FORMAT,
    version: BOT_MOVE_PACKAGE_VERSION,
    appVersion,
    botId,
    createdAt: Date.now(),
    digest,
    rows: { size: rowsBytes.length, sha256: createHash('sha256').update(rowsBytes).digest('hex') },
    entries,
    links: sources.links,
    directories: sources.directories,
  }
  const partial = `${destination}.${randomUUID()}.partial`
  const pack = tar.pack()
  const written = pipeline(pack, createZstdCompress(), createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
  try {
    const add = (name: string, bytes: Buffer) =>
      new Promise<void>((resolve, reject) =>
        pack.entry({ name, size: bytes.length, mode: 0o600 }, bytes, (error) => (error ? reject(error) : resolve()))
      )
    await add(MANIFEST, Buffer.from(JSON.stringify(manifest)))
    await add(ROWS, rowsBytes)
    for (const [index, entry] of entries.entries()) {
      const hash = createHash('sha256')
      await new Promise<void>((resolve, reject) => {
        const sink = pack.entry({ name: entry.path, size: entry.size, mode: entry.mode }, (error) =>
          error ? reject(error) : resolve()
        )
        const hashing = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk)
            callback(null, chunk)
          },
        })
        pipeline(createReadStream(sources.files[index].absolute), hashing, sink).catch(reject)
      })
      // The bot is frozen while it is packed; a change here means something wrote to its files anyway.
      if (hash.digest('hex') !== entry.sha256) throw invalid('A file of the bot changed while it was packed.')
    }
    pack.finalize()
    await written
    await rename(partial, destination)
  } catch (error) {
    pack.destroy()
    await written.catch(() => undefined)
    await rm(partial, { force: true })
    throw error
  }
  const info = await lstat(destination)
  return { size: info.size, sha256: await hashFile(destination), digest }
}

/**
 * Writes a package arriving as a stream into `destination`, refusing one larger than announced or than a package may
 * be, shorter than announced, or whose bytes do not hash to `sha256`.
 */
export async function receiveBotPackage(
  body: Readable,
  destination: string,
  expected: { size: number; sha256: string }
): Promise<void> {
  if (
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0 ||
    expected.size > FLEET_BOT_MOVE_LIMITS.packageMaxBytes
  )
    throw invalid('Invalid package size.')
  if (!/^[0-9a-f]{64}$/.test(expected.sha256)) throw invalid('Invalid package digest.')
  const hash = createHash('sha256')
  let size = 0
  const counting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (size > expected.size) return callback(invalid('The package is larger than announced.'))
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(body, counting, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  } catch (error) {
    await rm(destination, { force: true })
    if (error instanceof InstanceHttpError) throw error
    throw invalid('The package did not arrive whole.')
  }
  if (size !== expected.size || hash.digest('hex') !== expected.sha256) {
    await rm(destination, { force: true })
    throw invalid('The package differs from what was sent.')
  }
}

async function readBuffer(stream: Readable, limit: number, name: string): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += (chunk as Buffer).length
    if (size > limit) throw invalid(`${name} is too large.`)
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function parseManifest(bytes: Buffer, expected: { appVersion: string; botId: string }): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw invalid('The package manifest is not JSON.')
  }
  const head = raw as { format?: unknown; version?: unknown; appVersion?: unknown; botId?: unknown } | null
  if (head?.format !== BOT_MOVE_PACKAGE_FORMAT || head.version !== BOT_MOVE_PACKAGE_VERSION)
    throw invalid('This is not a bot package this environment can read.')
  if (head.appVersion !== expected.appVersion)
    throw new InstanceHttpError(
      409,
      'CONFLICT',
      `The bot was packed by Maestrly ${String(head.appVersion)}; this environment runs ${expected.appVersion}.`
    )
  if (head.botId !== expected.botId) throw invalid('The package holds another bot.')
  const parsed = manifestSchema.safeParse(raw)
  if (!parsed.success) throw invalid('The package manifest is malformed.')
  const manifest = parsed.data
  let total = manifest.rows.size
  const paths = new Set<string>()
  for (const entry of manifest.entries) {
    const relative = packageRelative(entry.relative)
    if (!relative || entry.path !== entryPath(entry.kind, relative) || paths.has(entry.path))
      throw invalid(`Unsafe or duplicate package entry: ${entry.path}`)
    paths.add(entry.path)
    total += entry.size
  }
  const links = new Set<string>()
  for (const link of manifest.links) {
    if (
      !packageRelative(link.relative) ||
      link.target.includes('\0') ||
      (!link.rooted && (!link.target || path.posix.isAbsolute(link.target))) ||
      links.has(link.relative)
    )
      throw invalid(`Unsafe or duplicate package link: ${link.relative}`)
    links.add(link.relative)
  }
  const directories = new Set<string>()
  for (const directory of manifest.directories) {
    if (!packageRelative(directory) || directories.has(directory) || links.has(directory))
      throw invalid(`Unsafe or duplicate package folder: ${directory}`)
    directories.add(directory)
  }
  if (total > FLEET_BOT_MOVE_LIMITS.packageMaxBytes) throw invalid('The package is too large.')
  return manifest
}

const rowsSchema = z.object({
  stored: z.object({ profile: fleetInstanceProfileSchema, primaryConversationId: conversationIdSchema.nullable() }),
  paused: z.boolean(),
  conversation: z
    .object({
      conversation: z.object({ id: conversationIdSchema }).passthrough(),
      tables: z.record(z.string(), z.unknown()),
    })
    .passthrough()
    .nullable(),
  runs: z
    .array(
      z.object({
        runId: z.string().min(1),
        conversation: z
          .object({
            conversation: z.object({ id: conversationIdSchema }).passthrough(),
            tables: z.record(z.string(), z.unknown()),
          })
          .passthrough(),
        extraction: z.record(z.string(), z.unknown()).nullable(),
      })
    )
    .default([]),
  memories: z.array(z.record(z.string(), z.unknown())),
  extraction: z.record(z.string(), z.unknown()).nullable(),
  consolidation: z.record(z.string(), z.unknown()).nullable(),
})

/** Extracts a package into `directory`, which must not exist yet; every byte is checked against the manifest. */
async function readBotPackage(
  file: string,
  directory: string,
  expected: { appVersion: string; botId: string }
): Promise<{ manifest: Manifest; rows: BotMoveRows; files: Array<Entry & { absolute: string }> }> {
  await mkdir(directory, { recursive: false, mode: 0o700 })
  const read: { manifest: Manifest | null; rows: BotMoveRows | null } = { manifest: null, rows: null }
  const files: Array<Entry & { absolute: string }> = []
  const declared = new Map<string, Entry>()
  const seen = new Set<string>()
  let failure: unknown = null
  const extract = tar.extract()
  const consume = async (header: tar.Header, stream: Readable): Promise<void> => {
    if (header.type !== 'file') throw invalid(`Unsupported package entry: ${header.name}`)
    const manifest = read.manifest
    if (!manifest) {
      if (header.name !== MANIFEST) throw invalid('The package does not start with its manifest.')
      read.manifest = parseManifest(await readBuffer(stream, 256 * 1024 * 1024, MANIFEST), expected)
      for (const entry of read.manifest.entries) declared.set(entry.path, entry)
      return
    }
    if (seen.has(header.name)) throw invalid(`Duplicate package entry: ${header.name}`)
    seen.add(header.name)
    if (header.name === ROWS) {
      const bytes = await readBuffer(stream, manifest.rows.size, ROWS)
      if (
        bytes.length !== manifest.rows.size ||
        createHash('sha256').update(bytes).digest('hex') !== manifest.rows.sha256
      )
        throw invalid('The rows of the bot differ from the manifest.')
      let value: unknown
      try {
        value = JSON.parse(bytes.toString('utf8'))
      } catch {
        throw invalid('The rows of the bot are not JSON.')
      }
      const parsed = rowsSchema.safeParse(value)
      if (!parsed.success || parsed.data.stored.profile.botId !== expected.botId)
        throw invalid('The rows of the bot are malformed.')
      if (
        parsed.data.conversation &&
        parsed.data.conversation.conversation.id !== parsed.data.stored.primaryConversationId
      )
        throw invalid('The rows of the bot name another conversation.')
      const runIds = parsed.data.runs.map((run) => run.conversation.conversation.id)
      if (
        (parsed.data.runs.length && !parsed.data.conversation) ||
        new Set(runIds).size !== runIds.length ||
        runIds.includes(parsed.data.stored.primaryConversationId ?? '')
      )
        throw invalid('The routine runs of the bot are malformed.')
      read.rows = value as BotMoveRows
      return
    }
    const entry = declared.get(header.name)
    if (!entry) throw invalid(`Undeclared package entry: ${header.name}`)
    if (header.size !== entry.size) throw invalid(`${entry.path} differs from the manifest.`)
    const absolute = path.join(directory, entry.path)
    await mkdir(path.dirname(absolute), { recursive: true })
    const handle = await open(absolute, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0
    try {
      const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          size += chunk.length
          if (size > entry.size) return callback(invalid(`${entry.path} is larger than declared.`))
          hash.update(chunk)
          handle.write(chunk).then(() => callback(), callback)
        },
      })
      await pipeline(stream, sink)
    } finally {
      await handle.close()
    }
    if (size !== entry.size || hash.digest('hex') !== entry.sha256)
      throw invalid(`${entry.path} differs from the manifest.`)
    files.push({ ...entry, absolute })
  }
  extract.on('entry', (header, stream, next) => {
    if (failure) {
      stream.resume()
      return next()
    }
    consume(header, stream as unknown as Readable).then(
      () => next(),
      (error) => {
        failure = error
        stream.resume()
        next()
      }
    )
  })
  try {
    await pipeline(createReadStream(file), createZstdDecompress(), extract)
  } catch (error) {
    failure ??= error instanceof InstanceHttpError ? error : invalid('The package cannot be read.')
  }
  if (!failure && !read.manifest) failure = invalid('The package is empty.')
  if (!failure && !read.rows) failure = invalid('The package has no rows.')
  if (!failure && seen.size !== declared.size + 1) failure = invalid('The package is missing declared entries.')
  if (failure) {
    await rm(directory, { recursive: true, force: true })
    throw failure
  }
  return { manifest: read.manifest!, rows: read.rows!, files }
}

const SQL_VALUE_TYPES = new Set(['string', 'number', 'bigint'])
function sqlRow(
  row: Row,
  table: string,
  columns: ReadonlySet<string>
): Record<string, string | number | bigint | null> {
  const out: Record<string, string | number | bigint | null> = {}
  for (const [name, value] of Object.entries(row)) {
    if (!columns.has(name)) throw invalid(`Schema mismatch: ${table}.${name}.`)
    if (value === null || value === undefined) out[name] = null
    else if (SQL_VALUE_TYPES.has(typeof value)) out[name] = value as string | number | bigint
    else throw invalid(`Unexpected value in ${table}.${name}.`)
  }
  return out
}
function insertRow(table: string, row: Record<string, string | number | bigint | null>): void {
  const names = Object.keys(row)
  getDb()
    .prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
    .run(...names.map((name) => row[name]))
}
const columnsOf = (table: string): Set<string> =>
  new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((item) => item.name))

/** The memory space's entries, then what extraction and consolidation kept for it; in one transaction. */
function insertMemoryRows(botId: string, rows: BotMoveRows): void {
  const space = botMemorySpaceId(botId)
  transaction(() => {
    const columns = columnsOf('local_memories')
    const links: Array<[unknown, unknown]> = []
    for (const raw of rows.memories) {
      if (raw.workspace_id !== space) throw invalid('A memory of the package belongs to another space.')
      const row = sqlRow(raw, 'local_memories', columns)
      // Entries may supersede each other in any order: the links are set once all of them are in.
      if (row.supersedes_id !== null && row.supersedes_id !== undefined) links.push([row.id, row.supersedes_id])
      insertRow('local_memories', { ...row, supersedes_id: null })
    }
    const link = getDb().prepare('UPDATE local_memories SET supersedes_id = ? WHERE id = ? AND workspace_id = ?')
    for (const [id, supersedes] of links) link.run(supersedes as string, id as string, space)
    if (rows.extraction) {
      const conversationId = rows.stored.primaryConversationId
      if (rows.extraction.conversation_id !== conversationId || rows.extraction.space_id !== space || !conversationId)
        throw invalid('The memory extraction state of the package is not the bot conversation.')
      insertRow(
        'memory_extraction_state',
        sqlRow(rows.extraction, 'memory_extraction_state', columnsOf('memory_extraction_state'))
      )
    }
    for (const run of rows.runs ?? []) {
      if (!run.extraction) continue
      if (run.extraction.conversation_id !== run.conversation.conversation.id || run.extraction.space_id !== space)
        throw invalid('The memory extraction state of a routine run is not its conversation.')
      insertRow(
        'memory_extraction_state',
        sqlRow(run.extraction, 'memory_extraction_state', columnsOf('memory_extraction_state'))
      )
    }
    if (rows.consolidation) {
      if (rows.consolidation.space_id !== space) throw invalid('The memory state of the package is another space.')
      insertRow(
        'memory_consolidation_state',
        sqlRow(rows.consolidation, 'memory_consolidation_state', columnsOf('memory_consolidation_state'))
      )
    }
  })
}

/**
 * Puts one extracted file in its place, never through a link and never over an existing file. The extracted copy is
 * deleted with its staging folder, so the file is linked there when both are on one file system, and copied otherwise.
 */
async function placeFile(from: string, root: string, relative: string, mode: number): Promise<void> {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(target))])
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep))
    throw invalid(`${relative} would be written outside its folder.`)
  try {
    await hardLink(from, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw error
      return copyFile(from, target, fsConstants.COPYFILE_EXCL)
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw invalid(`${relative} is already here.`)
    throw error
  }
  await chmod(target, mode & 0o777)
}
/** Makes a link of the working folder `root` (a real path) as it was, refusing one that leads out of it as written. */
async function placeLink(root: string, link: Link): Promise<void> {
  const target = path.join(root, link.relative)
  const text = linkText(root, link)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  if (!within(root, await realpath(path.dirname(target))) || !within(root, path.resolve(path.dirname(target), text)))
    throw invalid(`${link.relative} would lead outside its folder.`)
  try {
    await symlink(text, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw invalid(`${link.relative} is already here.`)
    throw error
  }
}

/**
 * Imports a received package: the bot's conversation with its own ids and files, its memory space, its folders, and
 * last its settings. It is not installed: the gateway installs it here once the move commits. The bot must have
 * nothing here yet; a failure deletes whatever the import wrote, and nothing else.
 */
export async function importBotPackage(
  botId: string,
  roots: BotRoots,
  file: string,
  directory: string,
  appVersion: string
): Promise<void> {
  const { manifest, rows, files } = await readBotPackage(file, directory, { appVersion, botId })
  const conversationId = rows.stored.primaryConversationId
  let inserted = false
  const insertedRuns: string[] = []
  try {
    await restore(
      botId,
      roots,
      rows,
      files,
      manifest,
      () => {
        inserted = true
      },
      (runConversationId) => insertedRuns.push(runConversationId)
    )
  } catch (error) {
    // Each step goes on its own: what could not be deleted stays for the next import, which replaces it.
    const runConversations = (rows.runs ?? []).map((run) => run.conversation.conversation.id)
    const steps: Array<() => unknown> = [
      () => deleteBotSettings(botId),
      () => deleteLocalMemorySpace(botMemorySpaceId(botId)),
      // The runs' conversations first: they work in the bot conversation's folder.
      ...insertedRuns.map((id) => () => deleteImportedConversationRows(id)),
      ...runConversations.map((id) => () => removeConversationLeftovers(roots, id)),
      () => (conversationId && inserted ? deleteImportedConversationRows(conversationId) : undefined),
      () => (conversationId ? removeConversationLeftovers(roots, conversationId) : undefined),
      ...BOT_FOLDERS.map((folder) => () => removeBotFolder(roots[folder.base], folder.segments, botId)),
    ]
    for (const step of steps)
      await Promise.resolve()
        .then(step)
        .catch(() => undefined)
    if (error instanceof MoveError) {
      const exists = error.code === 'conversation-exists'
      throw new InstanceHttpError(exists ? 409 : 400, exists ? 'CONFLICT' : 'INVALID_REQUEST', error.message)
    }
    throw error
  }
}

async function restore(
  botId: string,
  roots: BotRoots,
  rows: BotMoveRows,
  files: Array<Entry & { absolute: string }>,
  tree: { links: readonly Link[]; directories: readonly string[] },
  onInserted: () => void,
  onRunInserted: (conversationId: string) => void
): Promise<void> {
  const conversationId = rows.stored.primaryConversationId
  const folders = new Map(BOT_FOLDERS.filter((folder) => folder.moves).map((folder) => [folder.kind, folder]))
  let workdir: string | null = null
  if (conversationId && rows.conversation) {
    if (getConversation(conversationId))
      throw new InstanceHttpError(409, 'CONFLICT', 'The conversation of this bot is already here.')
    await removeConversationLeftovers(roots, conversationId)
    workdir = await workdirOf(roots, conversationId)
    // Its managed folder is made as a new standalone chat makes it: owner only, and never one that already exists.
    await mkdir(path.dirname(workdir), { recursive: true, mode: 0o700 })
    await mkdir(workdir, { mode: 0o700 })
    insertStandaloneConversationRows(rows.conversation, workdir)
    onInserted()
  } else if (conversationId) throw invalid('The package names a conversation it does not hold.')
  // The routine runs' conversations work in the bot conversation's folder, as they did where the bot was.
  const runConversations = new Set<string>()
  for (const run of rows.runs ?? []) {
    const runConversationId = run.conversation.conversation.id
    if (!conversationId || !workdir) throw invalid('The package holds routine runs without the bot conversation.')
    if (getConversation(runConversationId))
      throw new InstanceHttpError(409, 'CONFLICT', 'The conversation of a routine run of this bot is already here.')
    await removeConversationLeftovers(roots, runConversationId)
    insertStandaloneConversationRows(run.conversation, workdir, { folderOwnerId: conversationId })
    onRunInserted(runConversationId)
    runConversations.add(runConversationId)
  }
  // The working folder's folders first, empty ones included; nothing in it is a link yet.
  if (tree.directories.length) {
    if (!workdir) throw invalid('The package holds folders without a conversation.')
    for (const directory of tree.directories)
      await mkdir(path.join(workdir, directory), { recursive: true, mode: 0o700 })
  }
  // Where each file goes, decided for all of them before any is placed.
  const placements = files.map((entry) => {
    if (entry.kind === 'run-attachment' || entry.kind === 'run-generated-image') {
      const [runConversationId, ...rest] = entry.relative.split('/')
      if (!runConversations.has(runConversationId) || !rest.length)
        throw invalid('The package holds files of a routine run it does not hold.')
      const root =
        entry.kind === 'run-attachment'
          ? attachmentConversationDir(runConversationId)
          : generatedImageConversationDir(runConversationId)
      return { entry, root, relative: rest.join('/') }
    }
    if (entry.kind === 'workdir' || entry.kind === 'attachment' || entry.kind === 'generated-image') {
      if (!conversationId || !workdir) throw invalid('The package holds conversation files without a conversation.')
      const root =
        entry.kind === 'workdir'
          ? workdir
          : entry.kind === 'attachment'
            ? attachmentConversationDir(conversationId)
            : generatedImageConversationDir(conversationId)
      return { entry, root, relative: entry.relative }
    }
    return { entry, root: botFolderPath(folders.get(entry.kind)!, roots, botId), relative: entry.relative }
  })
  for (const root of new Set(placements.map((placement) => placement.root)))
    await mkdir(root, { recursive: true, mode: 0o700 })
  await mapLimit(placements, FILE_CONCURRENCY, ({ entry, root, relative }) =>
    placeFile(entry.absolute, root, relative, entry.mode)
  )
  // Links come last, so that no file is written through one.
  const { links } = tree
  if (links.length) {
    if (!workdir) throw invalid('The package holds links without a conversation.')
    for (const link of links) await placeLink(workdir, link)
    // A link may lead through another: resolved, none may lead out of the working folder.
    for (const link of links)
      if (!(await insideLink(workdir, link.relative))) throw invalid(`${link.relative} would lead outside its folder.`)
  }
  insertMemoryRows(botId, rows)
  writeBotPaused(botId, rows.paused)
  writeStoredProfile(botId, {
    profile: fleetInstanceProfileSchema.parse(rows.stored.profile),
    primaryConversationId: conversationId,
  })
}

/**
 * Removes what an interrupted import left of a conversation whose row is not here: its working folder and its files.
 * A conversation that is here keeps everything; deleting it is the purge's job.
 */
export async function removeConversationLeftovers(roots: BotRoots, conversationId: string): Promise<void> {
  // Only a standalone chat has a managed folder named by its id; nothing else is ever touched.
  if (!conversationIdSchema.safeParse(conversationId).success || getConversation(conversationId)) return
  await rm(await workdirOf(roots, conversationId), { recursive: true, force: true })
  await rm(attachmentConversationDir(conversationId), { recursive: true, force: true })
  await rm(generatedImageConversationDir(conversationId), { recursive: true, force: true })
}

/** Whether this environment holds anything of a bot: its settings, its memory space or one of its folders. */
export async function holdsBot(botId: string, roots: BotRoots): Promise<boolean> {
  if (readStoredProfile(botId)) return true
  if (memoryRows(botId).length) return true
  for (const folder of BOT_FOLDERS) if (await lstat(botFolderPath(folder, roots, botId)).catch(() => null)) return true
  return false
}

/** Removes the packages a process that stopped during a move left: no move runs while an environment starts. */
export async function sweepBotMoveStaging(roots: BotRoots): Promise<void> {
  await rm(path.join(roots.userData, 'bot-moves'), { recursive: true, force: true })
}

/** A fresh folder for one package and what is extracted from it, inside the environment's data folder. */
export async function botMoveStaging(roots: BotRoots): Promise<string> {
  const root = path.join(roots.userData, 'bot-moves')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = path.join(root, randomUUID())
  await mkdir(directory, { mode: 0o700 })
  return directory
}
/** Removes a package's folder, with what was extracted from it. */
export async function removeBotMoveStaging(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true })
}
