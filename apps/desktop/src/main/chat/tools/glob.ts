/** `glob` tool — lists files by pattern. Uses fs.promises.glob (Node 22+) with walk fallback. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { assertReviewerPathInside, defineTool, resolveInside, type ToolContext } from './util'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.cache', 'coverage', '.turbo'])

const params = z.object({
  pattern: z.string().describe('File glob pattern, e.g. "src/**/*.ts".'),
  path: z.string().optional().describe('Relative base directory; default = cwd.'),
  limit: z.number().int().positive().optional().describe('Maximum number of results.'),
})

function matchGlob(pattern: string, rel: string): boolean {
  // Glob → regex supporting ** (any depth), *, and ?.
  let re = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      re += '(?:.*/)?'
      i += 3
    } else if (pattern[i] === '*') {
      re += '[^/]*'
      i++
    } else if (pattern[i] === '?') {
      re += '[^/]'
      i++
    } else {
      re += pattern[i].replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i++
    }
  }
  return new RegExp('^' + re + '$').test(rel)
}

async function* walk(root: string, base: string): AsyncGenerator<string> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      yield* walk(full, base)
    } else if (e.isFile()) {
      yield path.relative(base, full).replaceAll('\\', '/')
    }
  }
}

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<string[]> {
  const { abs: base, external } = resolveInside(ctx.cwd, args.path ?? '.')
  if (external) await ctx.ask('external_directory', [base], [base])
  const effectiveBase = await assertReviewerPathInside(ctx, base)
  await ctx.ask('glob', [args.pattern])
  const limit = args.limit ?? 1000
  const out: string[] = []

  // fs.promises.glob is available in Node 22+ (Electron 42 uses Node ≥22) — preferred path.
  const globFn = (fsp as unknown as { glob?: (p: string, o?: object) => AsyncIterable<string> }).glob
  if (typeof globFn === 'function') {
    try {
      for await (const rel of globFn(args.pattern, { cwd: effectiveBase })) {
        if (rel.includes('node_modules') || rel.split(/[\\/]/).some((s) => SKIP_DIRS.has(s))) continue
        out.push(rel.replaceAll('\\', '/'))
        if (out.length >= limit) break
      }
      out.sort()
      return out
    } catch {
      /* Use fallback. */
    }
  }

  for await (const rel of walk(effectiveBase, effectiveBase)) {
    if (out.length >= limit || ctx.signal.aborted) break
    if (matchGlob(args.pattern, rel)) out.push(rel)
  }
  out.sort()
  return out
}

export const globTool = defineTool({
  name: 'glob',
  description: 'Lists project files matching a glob pattern (ignores .git/node_modules/dist).',
  parameters: params,
  execute: async (args, ctx) => {
    const result = await run(args, ctx)
    ctx.reviewer?.recordEvidence('search')
    return result
  },
  toModelText: (_args, files) => (files.length === 0 ? 'No files found.' : files.join('\n')),
})
