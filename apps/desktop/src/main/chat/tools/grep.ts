/** `grep` tool — uses ripgrep when available, with a NODE readline fallback. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { z } from 'zod'
import { assertReviewerPathInside, defineTool, isBinaryExt, resolveInside, type ToolContext } from './util'

// Do not skip all dot-directories (keep .github/.vscode searchable); list LARGE dot-directories by name.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', '.next', '.cache', 'coverage', '.turbo', '.agents', '.claude', '.venv', '.idea', '.vs', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.svn', '.hg', '.terraform'])

const params = z.object({
  pattern: z.string().describe('Regex (JavaScript dialect) searched in file contents.'),
  path: z.string().optional().describe('Relative directory to search; default = cwd.'),
  include: z.string().optional().describe('Simple glob of files to include, e.g. "*.ts" or "*.{ts,tsx}".'),
  limit: z.number().int().positive().optional().describe('Maximum number of matches.'),
})

interface Match {
  file: string
  line: number
  text: string
}

/** Simple glob → regex (supports *, ?, {a,b}). */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      if (end > i) {
        re += '(?:' + glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|') + ')'
        i = end + 1
        continue
      } else re += '\\{'
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i++
  }
  return new RegExp('^' + re + '$')
}

export function shouldSkipSearchDir(name: string): boolean {
  return SKIP_DIRS.has(name)
}

async function* walk(root: string): AsyncGenerator<string> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      if (shouldSkipSearchDir(e.name)) continue
      yield* walk(full)
    } else if (e.isFile()) {
      yield full
    }
  }
}

let rgAvailable: Promise<boolean> | null = null
function hasRipgrep(): Promise<boolean> {
  rgAvailable ??= new Promise((resolve) => {
    const p = spawn('rg', ['--version'], { stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })
  return rgAvailable
}

function rgArgs(args: z.infer<typeof params>, root: string): string[] {
  const out = ['--json', '--line-number', '--color', 'never', '--hidden', '--no-messages']
  // `!dir/**` anchors at the search ROOT (passed as absolute), excluding nothing — `**/` is needed to match
  // the directory at any depth (verified empirically with rg 14).
  for (const dir of SKIP_DIRS) out.push('--glob', `!**/${dir}/**`)
  if (args.include) out.push('--glob', args.include)
  out.push('--', args.pattern, root)
  return out
}

async function runRipgrep(args: z.infer<typeof params>, ctx: ToolContext, root: string, limit: number): Promise<Match[] | null> {
  if (!(await hasRipgrep())) return null
  return await new Promise<Match[] | null>((resolve) => {
    const out: Match[] = []
    const child = spawn('rg', rgArgs(args, root), { cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    let stderr = ''
    let killed = false
    const finishLine = (rawLine: string) => {
      if (!rawLine) return
      try {
        const ev = JSON.parse(rawLine) as { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } }
        if (ev.type !== 'match') return
        const file = ev.data?.path?.text
        const text = ev.data?.lines?.text
        const line = ev.data?.line_number
        if (typeof file !== 'string' || typeof text !== 'string' || typeof line !== 'number') return
        out.push({ file: path.relative(ctx.cwd, file), line, text: text.replace(/\r?\n$/, '').slice(0, 2000) })
        if (out.length >= limit && !killed) {
          killed = true
          child.kill()
        }
      } catch {
        /* Ignore partial/unexpected JSON lines. */
      }
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      for (;;) {
        const i = buf.indexOf('\n')
        if (i < 0) break
        finishLine(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    // Turn abort kills rg (otherwise it keeps scanning the repository to completion).
    const onAbort = () => {
      try {
        child.kill()
      } catch {
        /* Already exited. */
      }
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', () => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve(null)
    })
    child.on('close', (code) => {
      ctx.signal.removeEventListener('abort', onAbort)
      finishLine(buf)
      if (killed || code === 0 || code === 1) resolve(out)
      else {
        // Valid JS regex unsupported by rg (lookaround/backref etc.) → Node fallback preserves the contract.
        if (/regex parse error|error parsing regex/i.test(stderr)) resolve(null)
        else resolve(out)
      }
    })
  })
}

async function runNode(args: z.infer<typeof params>, ctx: ToolContext, root: string, re: RegExp, limit: number): Promise<Match[]> {
  const includeRe = args.include ? globToRegExp(args.include) : null
  const out: Match[] = []

  for await (const file of walk(root)) {
    if (out.length >= limit || ctx.signal.aborted) break
    if (isBinaryExt(file)) continue
    if (includeRe && !includeRe.test(path.basename(file))) continue
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
    let n = 0
    try {
      for await (const line of rl) {
        n++
        re.lastIndex = 0
        if (re.test(line)) {
          out.push({ file: path.relative(ctx.cwd, file), line: n, text: line.length > 2000 ? line.slice(0, 2000) + '…' : line })
          if (out.length >= limit) break
        }
      }
    } finally {
      rl.close()
    }
  }
  return out
}

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<Match[]> {
  const { abs: root, external } = resolveInside(ctx.cwd, args.path ?? '.')
  if (external) await ctx.ask('external_directory', [root], [root])
  const effectiveRoot = await assertReviewerPathInside(ctx, root)
  await ctx.ask('grep', [args.pattern])

  let re: RegExp
  try {
    re = new RegExp(args.pattern)
  } catch (e) {
    throw new Error(`Invalid regex: ${(e as Error).message}`)
  }
  const limit = args.limit ?? 500
  return (await runRipgrep(args, ctx, effectiveRoot, limit)) ?? runNode(args, ctx, effectiveRoot, re, limit)
}

export const grepTool = defineTool({
  name: 'grep',
  description: "Searches a regex in the project's file contents (ignores .git/node_modules/dist).",
  parameters: params,
  execute: async (args, ctx) => {
    const result = await run(args, ctx)
    ctx.reviewer?.recordEvidence('search')
    return result
  },
  toModelText: (_args, matches) => {
    if (matches.length === 0) return 'No matches.'
    const byFile = new Map<string, Match[]>()
    for (const m of matches) {
      const arr = byFile.get(m.file) ?? []
      arr.push(m)
      byFile.set(m.file, arr)
    }
    const blocks: string[] = [`${matches.length} match(es):`]
    for (const [file, ms] of byFile) {
      blocks.push(`\n${file}:`)
      for (const m of ms) blocks.push(`  Line ${m.line}: ${m.text}`)
    }
    return blocks.join('\n')
  },
})
