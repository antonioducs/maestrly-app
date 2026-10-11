import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const SKILL_DOCUMENT_MAX_BYTES = 262144
const mutations = new Map<string, Promise<unknown>>()
const activeMutations = new AsyncLocalStorage<ReadonlySet<string>>()

/** Shared by document editing and package installation, including local/import callers. */
export async function withSkillMutation<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  const key = path.resolve(dir)
  if (activeMutations.getStore()?.has(key)) return operation()
  const previous = mutations.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => activeMutations.run(new Set([...(activeMutations.getStore() ?? []), key]), operation))
  mutations.set(key, next)
  try {
    return await next
  } finally {
    if (mutations.get(key) === next) mutations.delete(key)
  }
}

export function assertSkillDocumentName(name: string): void {
  if (!/^[a-z0-9_][a-z0-9_-]{0,99}$/.test(name)) throw new Error('invalid-skill-name')
}

/** Reject symlinks in every existing component, including the managed root's parents. */
export async function assertSafeSkillPath(target: string, allowMissing = false): Promise<void> {
  const absolute = path.resolve(target)
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)
  let current = path.parse(absolute).root
  for (const part of parts) {
    current = path.join(current, part)
    const stat = await fsp.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (allowMissing && error.code === 'ENOENT') return null
      throw error
    })
    if (!stat) return
    if (stat.isSymbolicLink()) {
      // macOS exposes its system temporary directories through these fixed aliases.
      const systemAlias =
        process.platform === 'darwin' &&
        ['/var', '/tmp', '/etc'].includes(current) &&
        (await fsp.realpath(current)) === '/private' + current
      if (!systemAlias) throw new Error('read-only')
    }
  }
}

export function validateSkillMarkdown(name: string, markdown: string): void {
  assertSkillDocumentName(name)
  if (Buffer.byteLength(markdown, 'utf8') > SKILL_DOCUMENT_MAX_BYTES) throw new Error('skill-too-large')
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  const names = front?.[1].split(/\r?\n/).filter((line) => /^name\s*:/.test(line)) ?? []
  const value = names[0]
    ?.replace(/^name\s*:\s*/, '')
    .trim()
    .replace(/^["']|["']$/g, '')
  if (names.length !== 1 || value !== name) throw new Error('skill-name-mismatch')
  if (!markdown.slice(front?.[0].length ?? 0).trim()) throw new Error('empty')
}

export interface SkillDocumentSnapshot {
  markdown: string
  fingerprint: string
  editable: boolean
  editableReason: 'managed' | 'read-only' | 'not-found'
}

/** The fingerprint stays private; callers map it to an opaque public revision. */
export async function readSkillDocument(
  root: string,
  name: string,
  dir = path.join(root, name)
): Promise<SkillDocumentSnapshot> {
  assertSkillDocumentName(name)
  const file = path.join(dir, 'SKILL.md')
  let editable = path.resolve(dir) === path.join(path.resolve(root), name)
  try {
    await assertSafeSkillPath(file)
  } catch {
    editable = false
  }
  const handle = await fsp.open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return { markdown: '', fingerprint: 'missing', editable: false, editableReason: 'not-found' }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('read-only')
    if (stat.size > SKILL_DOCUMENT_MAX_BYTES) editable = false
    const buffer = Buffer.alloc(SKILL_DOCUMENT_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > SKILL_DOCUMENT_MAX_BYTES) editable = false
    const markdown = buffer.subarray(0, Math.min(bytesRead, SKILL_DOCUMENT_MAX_BYTES)).toString('utf8')
    try {
      validateSkillMarkdown(name, markdown)
    } catch {
      editable = false
    }
    const fingerprint = createHash('sha256')
      .update(markdown)
      .update(JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, editable]))
      .digest('hex')
    return { markdown, fingerprint, editable, editableReason: editable ? 'managed' : 'read-only' }
  } finally {
    await handle.close()
  }
}

/** Writes only SKILL.md; unknown frontmatter and all bundled files remain untouched. */
export async function writeSkillDocument(input: {
  root: string
  name: string
  markdown: string
  expectedFingerprint: string
  beforeCommit?: () => void
}): Promise<void> {
  validateSkillMarkdown(input.name, input.markdown)
  const dir = path.join(input.root, input.name)
  await withSkillMutation(dir, async () => {
    const before = await readSkillDocument(input.root, input.name)
    if (!before.editable) throw new Error('read-only')
    if (before.fingerprint !== input.expectedFingerprint) throw new Error('stale-revision')
    const file = path.join(dir, 'SKILL.md')
    const temporary = path.join(dir, `.SKILL-${randomUUID()}.tmp`)
    try {
      const stat = await fsp.lstat(file)
      const handle = await fsp.open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        stat.mode & 0o777
      )
      try {
        await handle.writeFile(input.markdown, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await assertSafeSkillPath(file)
      const current = await readSkillDocument(input.root, input.name)
      if (current.fingerprint !== before.fingerprint) throw new Error('stale-revision')
      input.beforeCommit?.()
      await fsp.rename(temporary, file)
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined)
    }
  })
}

export async function createSkillDocument(input: { root: string; name: string; markdown: string }): Promise<void> {
  validateSkillMarkdown(input.name, input.markdown)
  const dir = path.join(input.root, input.name)
  await withSkillMutation(dir, async () => {
    await assertSafeSkillPath(input.root, true)
    await fsp.mkdir(input.root, { recursive: true })
    await assertSafeSkillPath(input.root)
    await fsp.mkdir(dir)
    try {
      const handle = await fsp.open(path.join(dir, 'SKILL.md'), 'wx', 0o644)
      try {
        await handle.writeFile(input.markdown, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      await fsp.rm(dir, { recursive: true, force: true })
      throw error
    }
  })
}
