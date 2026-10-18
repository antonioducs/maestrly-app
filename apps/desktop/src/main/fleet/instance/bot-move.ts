import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
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
import { exactRelative } from '../../conversation-move/package'
import { MoveError } from '../../conversation-move/errors'
import {
  deleteImportedConversationRows,
  insertStandaloneConversationRows,
  readConversationRows,
  type MoveRows,
} from '../../conversation-move/rows'
import { botMemorySpaceId } from '../../memory/spaces'
import { deleteLocalMemorySpace, getConversation, getDb, transaction } from '../../store'
import { hashFile } from '../../transfer-io'
import {
  assertBotId,
  deleteBotSettings,
  readBotPaused,
  readStoredProfile,
  removeBotFolder,
  writeBotPaused,
  writeStoredProfile,
} from './registry'
import { InstanceHttpError } from './server'

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

/** The kinds of files a package carries: the bot's folders, and its conversation's working folder and files. */
export type BotMoveFileKind = Exclude<BotFolderKind, 'cache'> | 'workdir' | 'attachment' | 'generated-image'
const FILE_KINDS: readonly BotMoveFileKind[] = [
  'state',
  'inputs',
  'images',
  'browser',
  'workdir',
  'attachment',
  'generated-image',
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
  memories: Row[]
  /** Where memory extraction reached in its conversation, and the consolidation state of its memory space. */
  extraction: Row | null
  consolidation: Row | null
}

/** A standalone chat's id, as its managed folder is named (`standaloneConversationRelPath`). */
const conversationIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
const invalid = (message: string): InstanceHttpError => new InstanceHttpError(400, 'INVALID_REQUEST', message)
const isPartial = (name: string): boolean => name.endsWith('.tmp') || name.endsWith('.partial')

/** Regular files under `dir`, relative to it, in a stable order; links and special files never move. */
async function regularFiles(dir: string, prefix: string, skip: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  })
  if (!entries) return []
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip(entry.name)) continue
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isFile()) {
      if (!isPartial(entry.name)) out.push(relative)
    } else if (entry.isDirectory()) out.push(...(await regularFiles(path.join(dir, entry.name), relative, skip)))
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

/** Every file that moves with a bot, from where it is now. */
async function collectSources(botId: string, roots: BotRoots): Promise<Source[]> {
  const sources: Source[] = []
  for (const folder of BOT_FOLDERS) {
    if (!folder.moves) continue
    const dir = botFolderPath(folder, roots, botId)
    const skip = folder.kind === 'browser' ? (name: string) => BROWSER_CACHES.has(name) : () => false
    for (const relative of await regularFiles(dir, '', skip))
      sources.push({ kind: folder.kind as BotMoveFileKind, relative, absolute: path.join(dir, relative) })
  }
  const conversationId = conversationOf(botId)
  if (conversationId) {
    const folders: Array<[BotMoveFileKind, string]> = [
      ['workdir', await workdirOf(roots, conversationId)],
      ['attachment', attachmentConversationDir(conversationId)],
      ['generated-image', generatedImageConversationDir(conversationId)],
    ]
    for (const [kind, dir] of folders)
      for (const relative of await regularFiles(dir, '', () => false))
        sources.push({ kind, relative, absolute: path.join(dir, relative) })
  }
  return sources
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
async function filesDigest(sources: Source[]): Promise<{ files: number; filesSha256: string }> {
  const lines: string[] = []
  for (const source of sources) lines.push(`${source.kind}/${source.relative}:${await hashFile(source.absolute)}`)
  lines.sort()
  return { files: lines.length, filesSha256: createHash('sha256').update(lines.join('\n')).digest('hex') }
}

/**
 * What this environment holds of a bot, reduced to counts and hashes: the environment it leaves computes it when it
 * freezes the bot, the one it joins once it imported it, and both must agree.
 */
export async function botMoveDigest(botId: string, roots: BotRoots): Promise<FleetBotMoveDigest> {
  const conversationId = conversationOf(botId)
  const messages = conversationId
    ? messagesDigest(conversationId)
    : { conversationId: null, messages: 0, lastSeq: -1, messagesSha256: createHash('sha256').digest('hex') }
  return fleetBotMoveDigestSchema.parse({
    ...messages,
    ...memoriesDigest(botId),
    ...(await filesDigest(await collectSources(botId, roots))),
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
})
type Manifest = z.infer<typeof manifestSchema>
const MANIFEST = 'manifest.json'
const ROWS = 'rows.json'
const entryPath = (kind: BotMoveFileKind, relative: string): string => `files/${kind}/${relative}`

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
    memories: memoryRows(botId),
    extraction: conversationId
      ? ((getDb().prepare('SELECT * FROM memory_extraction_state WHERE conversation_id = ?').get(conversationId) as
          | Row
          | undefined) ?? null)
      : null,
    consolidation:
      (getDb().prepare('SELECT * FROM memory_consolidation_state WHERE space_id = ?').get(botMemorySpaceId(botId)) as
        | Row
        | undefined) ?? null,
  }
  const rowsBytes = Buffer.from(JSON.stringify(rows))
  const sources = await collectSources(botId, roots)
  const entries: Entry[] = []
  let total = rowsBytes.length
  for (const source of sources) {
    const relative = exactRelative(source.relative)
    if (!relative) throw invalid(`Unsafe package path: ${source.relative}`)
    const info = await lstat(source.absolute)
    if (!info.isFile()) throw invalid('A file of the bot changed while it was packed.')
    total += info.size
    entries.push({
      path: entryPath(source.kind, relative),
      kind: source.kind,
      relative,
      size: info.size,
      sha256: await hashFile(source.absolute),
      mode: info.mode & 0o777,
    })
  }
  if (total > FLEET_BOT_MOVE_LIMITS.packageMaxBytes)
    throw new InstanceHttpError(409, 'CONFLICT', 'This bot has too many files to move.')
  const digest = await botMoveDigest(botId, roots)
  const manifest: Manifest = {
    format: BOT_MOVE_PACKAGE_FORMAT,
    version: BOT_MOVE_PACKAGE_VERSION,
    appVersion,
    botId,
    createdAt: Date.now(),
    digest,
    rows: { size: rowsBytes.length, sha256: createHash('sha256').update(rowsBytes).digest('hex') },
    entries,
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
        pipeline(createReadStream(sources[index].absolute), hashing, sink).catch(reject)
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
    const relative = exactRelative(entry.relative)
    if (!relative || entry.path !== entryPath(entry.kind, relative) || paths.has(entry.path))
      throw invalid(`Unsafe or duplicate package entry: ${entry.path}`)
    paths.add(entry.path)
    total += entry.size
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
    if (rows.consolidation) {
      if (rows.consolidation.space_id !== space) throw invalid('The memory state of the package is another space.')
      insertRow(
        'memory_consolidation_state',
        sqlRow(rows.consolidation, 'memory_consolidation_state', columnsOf('memory_consolidation_state'))
      )
    }
  })
}

/** Copies one extracted file to its place, never through a link and never over an existing file. */
async function placeFile(from: string, root: string, relative: string, mode: number): Promise<void> {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(target))])
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep))
    throw invalid(`${relative} would be written outside its folder.`)
  try {
    await copyFile(from, target, fsConstants.COPYFILE_EXCL)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw invalid(`${relative} is already here.`)
    throw error
  }
  await chmod(target, mode & 0o777)
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
  const { rows, files } = await readBotPackage(file, directory, { appVersion, botId })
  const conversationId = rows.stored.primaryConversationId
  let inserted = false
  try {
    await restore(botId, roots, rows, files, () => {
      inserted = true
    })
  } catch (error) {
    // Each step goes on its own: what could not be deleted stays for the next import, which replaces it.
    const steps: Array<() => unknown> = [
      () => deleteBotSettings(botId),
      () => deleteLocalMemorySpace(botMemorySpaceId(botId)),
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
  onInserted: () => void
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
  for (const entry of files) {
    let root: string
    if (entry.kind === 'workdir' || entry.kind === 'attachment' || entry.kind === 'generated-image') {
      if (!conversationId || !workdir) throw invalid('The package holds conversation files without a conversation.')
      root =
        entry.kind === 'workdir'
          ? workdir
          : entry.kind === 'attachment'
            ? attachmentConversationDir(conversationId)
            : generatedImageConversationDir(conversationId)
    } else root = botFolderPath(folders.get(entry.kind)!, roots, botId)
    await mkdir(root, { recursive: true, mode: 0o700 })
    await placeFile(entry.absolute, root, entry.relative, entry.mode)
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
