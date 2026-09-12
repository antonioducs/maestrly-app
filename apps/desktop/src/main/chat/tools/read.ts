/** `read` tool — ported from opencode tool/read.ts + read-filesystem.ts (without Effect). */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import {
  assertReviewerPathInside,
  defineTool,
  isBinaryExt,
  isProbablyBinary,
  mimeOf,
  resolveInside,
  type ToolContext,
} from './util'

const MAX_READ_LINES = 2000
const MAX_LINE_LENGTH = 2000

const params = z.object({
  path: z.string().describe('File or directory path (relative to the conversation cwd, or absolute).'),
  offset: z.number().int().positive().optional().describe('1-based start line (file) or entry index (directory).'),
  limit: z.number().int().positive().max(MAX_READ_LINES).optional().describe('Maximum number of lines/entries.'),
})

type ReadResult =
  | { kind: 'file'; resource: string; content: string; truncated: boolean; next?: number }
  | { kind: 'dir'; resource: string; entries: { name: string; type: 'file' | 'dir'; mime: string }[]; truncated: boolean }

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<ReadResult> {
  const { abs, external } = resolveInside(ctx.cwd, args.path)
  if (external) await ctx.ask('external_directory', [abs], [abs])
  const effectiveAbs = await assertReviewerPathInside(ctx, abs)
  const rel = path.relative(ctx.cwd, abs) || path.basename(abs)
  await ctx.ask('read', [rel])

  const stat = await fs.stat(effectiveAbs)
  if (stat.isDirectory()) {
    const offset = (args.offset ?? 1) - 1
    const limit = args.limit ?? 100
    const names = await fs.readdir(effectiveAbs)
    const entries = await Promise.all(
      names.map(async (name) => {
        const s = await fs.stat(path.join(effectiveAbs, name)).catch(() => null)
        const type: 'file' | 'dir' = s?.isDirectory() ? 'dir' : 'file'
        return { name, type, mime: type === 'dir' ? 'application/x-directory' : mimeOf(name) }
      }),
    )
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    const page = entries.slice(offset, offset + limit)
    return { kind: 'dir', resource: rel, entries: page, truncated: offset + limit < entries.length }
  }

  // File.
  if (isBinaryExt(effectiveAbs)) throw new Error(`Unsupported binary file: ${rel}`)
  const buf = await fs.readFile(effectiveAbs)
  if (isProbablyBinary(buf)) throw new Error(`Unsupported binary file: ${rel}`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    throw new Error(`Unsupported binary file: ${rel}`)
  }
  const allLines = text.split('\n')
  const offset = args.offset ? args.offset - 1 : 0
  const limit = args.limit ?? MAX_READ_LINES
  if (offset >= allLines.length && offset > 0) throw new Error(`Offset ${args.offset} out of range (${allLines.length} lines).`)
  const slice = allLines.slice(offset, offset + limit)
  const clipped = slice.map((l) => (l.length > MAX_LINE_LENGTH ? l.slice(0, MAX_LINE_LENGTH) + '… (line truncated)' : l))
  const stoppedAt = offset + slice.length
  const truncated = stoppedAt < allLines.length
  return {
    kind: 'file',
    resource: rel,
    content: clipped.join('\n'),
    truncated,
    next: truncated ? stoppedAt + 1 : undefined,
  }
}

export const readTool = defineTool({
  name: 'read',
  description: "Reads a file's contents (paginated by lines) or lists a directory.",
  parameters: params,
  execute: async (args, ctx) => {
    const result = await run(args, ctx)
    ctx.reviewer?.recordEvidence('read')
    return result
  },
  toModelText: (_args, r) => {
    if (r.kind === 'dir') {
      const lines = r.entries.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`)
      const more = r.truncated ? '\n… (more entries; use offset/limit)' : ''
      return `${r.resource}/\n${lines.join('\n')}${more}`
    }
    const foot = r.truncated ? `\n\n… (truncated; continue at offset=${r.next})` : ''
    return `${r.resource}:\n${r.content}${foot}`
  },
})
