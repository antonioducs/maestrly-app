/** `bash` tool — ported from opencode tool/bash.ts (without Effect). Capture/cap/timeout/process-group kill. */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, resolveInside, type ToolContext } from './util'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_CAPTURE_BYTES = 1_048_576 // 1 MiB per stream.

const params = z.object({
  command: z.string().describe('Shell command to run.'),
  workdir: z.string().optional().describe('Working directory; a relative path resolves from the conversation cwd.'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Timeout in ms (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
  description: z.string().optional().describe('Short description of what the command does.'),
})

interface BashResult {
  command: string
  cwd: string
  exitCode?: number
  output: string
  timedOut?: boolean
  truncated: boolean
}

function compact(stdout: string, stderr: string): string {
  if (stdout && stderr) return `${stdout}\n\nstderr:\n${stderr}`
  if (stderr) return `stderr:\n${stderr}`
  if (stdout) return stdout
  return '(no output)'
}

function commandTokens(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const ch of command.trim()) {
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

export function bashPermissionSavePattern(command: string): string {
  const toks = commandTokens(command)
  if (toks.length === 0) return command
  const prefix = toks.slice(0, Math.min(2, toks.length)).join(' ')
  return `${prefix} *`
}

/**
 * Splits top-level SUBCOMMANDS (&&, ||, ;, |, &, newline — outside quotes), including command
 * substitution contents (dollar-parenthesis and backticks) as extra segments. Each segment becomes a
 * gate resource: a saved "npm test *" rule must NOT authorize "npm test && rm -rf /" — the broker requires
 * allow for ALL resources. Otherwise, the prefix wildcard would match the entire chained command.
 */
export function commandSegments(command: string): string[] {
  // Heredoc body is stdin (arbitrary lines) — a simple parser cannot segment it; gate the literal command.
  if (/<<-?\s*["']?\w/.test(command)) return [command.trim()]
  const segs: string[] = []
  let cur = ''
  let single = false
  let double = false
  let escaped = false
  const push = () => {
    const t = cur.trim()
    if (t) segs.push(t)
    cur = ''
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (single) {
      cur += ch
      if (ch === "'") single = false
      continue
    }
    if (ch === '\\') {
      cur += ch
      escaped = true
      continue
    }
    if (ch === "'" && !double) {
      single = true
      cur += ch
      continue
    }
    if (ch === '"') {
      double = !double
      cur += ch
      continue
    }
    // Command substitution (also executes inside double quotes) → gate its inner contents too.
    if (command.startsWith('$(', i)) {
      let depth = 1
      let j = i + 2
      while (j < command.length && depth > 0) {
        if (command[j] === '(') depth++
        else if (command[j] === ')') depth--
        j++
      }
      const inner = command.slice(i + 2, depth === 0 ? j - 1 : j)
      for (const s of commandSegments(inner)) segs.push(s)
      cur += command.slice(i, j)
      i = j - 1
      continue
    }
    if (ch === '`') {
      const close = command.indexOf('`', i + 1)
      const end = close === -1 ? command.length : close
      for (const s of commandSegments(command.slice(i + 1, end))) segs.push(s)
      cur += command.slice(i, close === -1 ? command.length : close + 1)
      i = close === -1 ? command.length : close
      continue
    }
    if (!double) {
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
        push()
        i++
        continue
      }
      if (ch === '|' && command[i + 1] === '&') {
        push()
        i++
        continue
      }
      if (ch === '|' || ch === ';' || ch === '\n') {
        push()
        continue
      }
      // Background & — not redirection & (2>&1, >&2).
      if (ch === '&' && command[i - 1] !== '>') {
        push()
        continue
      }
    }
    cur += ch
  }
  push()
  return segs
}

async function run(args: z.infer<typeof params>, ctx: ToolContext): Promise<BashResult> {
  const { abs: cwd, external } = resolveInside(ctx.cwd, args.workdir ?? '.')
  const stat = await fs.stat(cwd).catch(() => null)
  if (!stat || !stat.isDirectory()) throw new Error(`Invalid directory: ${cwd}`)
  if (external) await ctx.ask('external_directory', [cwd], [cwd])
  // Chained command → one resource PER subcommand (all need allow); "always" saves each prefix.
  const segments = commandSegments(args.command)
  const resources = segments.length > 1 ? segments : [args.command]
  await ctx.ask('bash', resources, [...new Set(resources.map(bashPermissionSavePattern))])

  const isWin = process.platform === 'win32'
  const shell = isWin ? process.env.COMSPEC ?? 'cmd.exe' : '/bin/sh'
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS

  return await new Promise<BashResult>((resolve, reject) => {
    const child = spawn(args.command, [], {
      cwd,
      shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !isWin,
    })
    let out: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let err: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let outTrunc = false
    let errTrunc = false
    let timedOut = false
    let done = false

    const cap = (buf: Buffer<ArrayBufferLike>, chunk: Buffer, mark: () => void): Buffer<ArrayBufferLike> => {
      if (buf.length >= MAX_CAPTURE_BYTES) {
        mark()
        return buf
      }
      const room = MAX_CAPTURE_BYTES - buf.length
      if (chunk.length > room) {
        mark()
        return Buffer.concat([buf, chunk.subarray(0, room)])
      }
      return Buffer.concat([buf, chunk])
    }

    const kill = () => {
      try {
        if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        else if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* Already exited. */
      }
      setTimeout(() => {
        try {
          if (isWin) child.kill('SIGKILL')
          else if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* ok */
        }
      }, 3000)
    }

    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeout)
    const onAbort = () => kill()
    ctx.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (c: Buffer) => {
      out = cap(out, c, () => (outTrunc = true))
    })
    child.stderr?.on('data', (c: Buffer) => {
      err = cap(err, c, () => (errTrunc = true))
    })
    child.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      if (timedOut) {
        resolve({
          command: args.command,
          cwd,
          output: `Command exceeded the ${timeout} ms timeout. Try again with a larger timeout if it is expected to take long.`,
          truncated: false,
          timedOut: true,
        })
        return
      }
      resolve({
        command: args.command,
        cwd,
        exitCode: code ?? undefined,
        output: compact(out.toString('utf8'), err.toString('utf8')),
        truncated: outTrunc || errTrunc,
      })
    })
  })
}

export const bashTool = defineTool({
  name: 'bash',
  description:
    'Runs a shell command in the conversation directory and returns stdout/stderr. Use it for builds, tests, git and inspecting the project.',
  parameters: params,
  execute: run,
  toModelText: (_args, r) => {
    if (r.timedOut) return r.output
    const warn = r.truncated ? '\n\n(output truncated)' : ''
    return `${r.output}${warn}\n\nCommand exited with code ${r.exitCode ?? 'unknown'}.`
  },
})
