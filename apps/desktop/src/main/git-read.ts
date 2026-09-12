import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runGitRaw } from './git-command'
import type { RepositoryScope } from './repository-scope'

export type GitReadOperation = 'status' | 'log' | 'show' | 'blame' | 'branches' | 'remotes' | 'diff' | 'ls-files'

export interface GitReadInput {
  operation: GitReadOperation
  repo?: string
  ref?: string
  path?: string
  limit?: number
  line_start?: number
  line_end?: number
}

export interface GitReadResult {
  operation: GitReadOperation
  repo: string
  data: unknown
}

const TIMEOUT_MS = 20_000
const MAX_OUTPUT_CHARS = 1_000_000
const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_UNTRACKED_FILES = 100
const BINARY_EXTENSIONS = new Set([
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.class',
  '.jar',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.woff',
  '.woff2',
  '.ttf',
])

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
  return Number.isInteger(value) && value! > 0 && value! <= max ? value! : fallback
}

function safeRef(value: string | undefined, fallback = 'HEAD'): string {
  const ref = value || fallback
  if (ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('Invalid Git ref.')
  return ref
}

function cap(value: string): { text: string; truncated: boolean } {
  return value.length > MAX_OUTPUT_CHARS
    ? { text: value.slice(0, MAX_OUTPUT_CHARS), truncated: true }
    : { text: value, truncated: false }
}

function lines(value: string): string[] {
  return value ? value.split('\n').filter(Boolean) : []
}

function isBinaryExtension(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function isProbablyBinary(buffer: Buffer): boolean {
  const size = Math.min(buffer.length, 4096)
  if (size === 0) return false
  let nonPrintable = 0
  for (let index = 0; index < size; index += 1) {
    const byte = buffer[index]
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable += 1
  }
  return nonPrintable / size > 0.3
}

function isPathOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
}

/** Same change-detection contract as the bridge's legacy single-repository git_diff. */
async function completeDiff(
  scope: RepositoryScope,
  input: GitReadInput,
  repositoryRoot: string,
  relativePath: string,
  raw: (args: string[]) => Promise<string>,
  signal?: AbortSignal
): Promise<string> {
  let output = ''
  let truncated = false
  const append = (piece: string) => {
    if (!piece) return
    if (output.length >= MAX_OUTPUT_CHARS) {
      truncated = true
      return
    }
    const separator = output ? '\n\n' : ''
    const available = MAX_OUTPUT_CHARS - output.length - separator.length
    if (available <= 0) {
      truncated = true
      return
    }
    output += separator + piece.slice(0, available)
    if (piece.length > available) truncated = true
  }

  const bestEffort = async (args: string[]) => {
    try {
      return await raw(args)
    } catch (error) {
      if (signal?.aborted) throw error
      return ''
    }
  }
  const pathArgs = relativePath ? ['--', relativePath] : []
  if (input.ref) {
    const base = safeRef(input.ref)
    append(await bestEffort(['diff', '--no-ext-diff', '--no-color', `${base}...HEAD`, ...pathArgs]))
    if (signal?.aborted) throw new Error('Git read canceled.')
    // The branch diff does not include staged or unstaged changes after HEAD.
    append(await bestEffort(['diff', '--no-ext-diff', '--no-color', 'HEAD', ...pathArgs]))
  } else {
    append(await bestEffort(['diff', '--no-ext-diff', '--no-color', ...pathArgs]))
  }
  if (signal?.aborted) throw new Error('Git read canceled.')

  const untracked = await bestEffort(['ls-files', '--others', '--exclude-standard'])
  const target = relativePath ? path.resolve(repositoryRoot, relativePath) : null
  const selector = input.repo || undefined
  let count = 0
  for (const relative of untracked
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item && !item.includes('\0') && !/[\r\n]/.test(item))) {
    if (signal?.aborted) throw new Error('Git read canceled.')
    if (output.length >= MAX_OUTPUT_CHARS || count >= MAX_UNTRACKED_FILES) break
    const candidate = path.resolve(repositoryRoot, relative)
    if (isPathOutside(repositoryRoot, candidate)) continue
    if (target) {
      const distance = path.relative(target, candidate)
      if (isPathOutside(target, candidate)) continue
      if (distance !== '' && path.isAbsolute(distance)) continue
    }

    let safeFile: string
    try {
      safeFile = (await scope.resolvePath(selector, relative)).absolutePath
    } catch {
      continue
    }
    count += 1
    if (isBinaryExtension(safeFile)) {
      append(
        `diff --git a/${relative} b/${relative}\nnew file mode 100644\nBinary files /dev/null and b/${relative} differ`
      )
      continue
    }

    let handle: Awaited<ReturnType<typeof fs.open>> | undefined
    let buffer: Buffer | undefined
    try {
      handle = await fs.open(safeFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile()) continue
      if (stat.size > MAX_READ_BYTES) {
        append(`Untracked file omitted because it exceeds the ${MAX_READ_BYTES}-byte limit: ${relative}`)
        continue
      }
      buffer = Buffer.alloc(stat.size)
      let bytesRead = 0
      while (bytesRead < buffer.length) {
        if (signal?.aborted) throw new Error('Git read canceled.')
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
        if (chunk.bytesRead === 0) break
        bytesRead += chunk.bytesRead
      }
      buffer = buffer.subarray(0, bytesRead)
    } catch {
      continue
    } finally {
      await handle?.close().catch(() => undefined)
    }
    if (isProbablyBinary(buffer ?? Buffer.alloc(0))) {
      append(
        `diff --git a/${relative} b/${relative}\nnew file mode 100644\nBinary files /dev/null and b/${relative} differ`
      )
      continue
    }
    const text = (buffer ?? Buffer.alloc(0)).toString('utf8')
    const bodyLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
    const lineCount = text ? bodyLines.length : 0
    const body = text ? bodyLines.map((line) => `+${line}`).join('\n') : ''
    append(
      [
        `diff --git a/${relative} b/${relative}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${relative}`,
        `@@ -0,0 +1,${lineCount} @@`,
        body,
      ]
        .filter(Boolean)
        .join('\n') + (text.endsWith('\n') ? '\n' : '')
    )
  }
  return truncated ? `${output}\n… [diff truncado]` : output
}

/** Structured, closed allowlist over the existing shell-free Git runner. */
export async function gitRead(
  scope: RepositoryScope,
  input: GitReadInput,
  signal?: AbortSignal
): Promise<GitReadResult> {
  const resolved = await scope.resolvePath(input.repo, input.path)
  const cwd = resolved.repository.realWorktreePath
  const pathArgs = input.path ? ['--', resolved.relativePath] : []
  const raw = (args: string[]) => runGitRaw(cwd, args, { timeoutMs: TIMEOUT_MS, signal })
  const trimmed = async (args: string[]) => (await raw(args)).trim()
  let data: unknown

  switch (input.operation) {
    case 'status': {
      const output = await raw(['status', '--porcelain=v1', '--branch', '-z', ...pathArgs])
      const records = output.split('\0').filter(Boolean)
      data = {
        branch: records.find((record) => record.startsWith('## '))?.slice(3) ?? '',
        entries: records.filter((r) => !r.startsWith('## ')),
      }
      break
    }
    case 'log': {
      const limit = boundedInteger(input.limit, 20, 200)
      const output = await raw([
        'log',
        `--max-count=${limit}`,
        '--date=iso-strict',
        '--format=%H%x00%h%x00%an%x00%aI%x00%s%x00',
        safeRef(input.ref),
        ...pathArgs,
      ])
      const fields = output.split('\0')
      const commits: Array<{ oid: string; shortOid: string; author: string; authoredAt: string; subject: string }> = []
      for (let index = 0; index + 4 < fields.length; index += 5) {
        const oid = fields[index].replace(/^\n+/, '')
        if (oid)
          commits.push({
            oid,
            shortOid: fields[index + 1],
            author: fields[index + 2],
            authoredAt: fields[index + 3],
            subject: fields[index + 4],
          })
      }
      data = { commits }
      break
    }
    case 'show': {
      const output = await raw(['show', '--no-ext-diff', '--no-color', safeRef(input.ref), ...pathArgs])
      data = cap(output)
      break
    }
    case 'blame': {
      if (!input.path) throw new Error('blame exige path.')
      const args = ['blame', '--line-porcelain']
      if (input.line_start !== undefined || input.line_end !== undefined) {
        const start = boundedInteger(input.line_start, 1, 10_000_000)
        const end = boundedInteger(input.line_end, start, 10_000_000)
        if (end < start) throw new Error('Invalid line range.')
        args.push('-L', `${start},${end}`)
      }
      if (input.ref) args.push(safeRef(input.ref))
      const output = await raw([...args, '--', resolved.relativePath])
      data = cap(output)
      break
    }
    case 'branches':
      data = { branches: lines(await trimmed(['branch', '--all', '--no-color', '--format=%(refname:short)'])) }
      break
    case 'remotes': {
      const output = await trimmed(['remote', '-v'])
      data = {
        remotes: lines(output).map((line) => {
          const [name, url, kind] = line.split(/\s+/)
          return { name, url, kind: kind?.replace(/[()]/g, '') }
        }),
      }
      break
    }
    case 'diff': {
      const output = await completeDiff(scope, input, cwd, resolved.relativePath, raw, signal)
      data = cap(output)
      break
    }
    case 'ls-files': {
      const output = await raw(['ls-files', '-z', ...pathArgs])
      data = { files: output.split('\0').filter(Boolean) }
      break
    }
    default:
      throw new Error('Unauthorized read-only Git operation.')
  }
  return { operation: input.operation, repo: resolved.repository.linkName, data }
}
