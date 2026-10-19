/** `bash` tool — ported from opencode tool/bash.ts (without Effect). Capture/cap/timeout/process-group kill. */
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { z } from 'zod'
import { trackCommandGroup } from '../../process-ownership/owned-groups'
import { unparsedCommandResource } from '../../../shared/permission-preview'
import { conversationShellEnv } from '../conversation-env'
import {
  agentCommandShell,
  bashToolDescription,
  type CommandDialect,
  type CommandShell,
  POWERSHELL_ARGS,
  systemCommandShell,
} from './command-shell'
import { splitCommand } from './command-segments'
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

export interface BashResult {
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
 * Subcommands the permission gate checks one by one (see `command-segments.ts`), or `null` when the command uses syntax
 * the splitter cannot read with certainty. `dialect` follows the shell that runs the command: PowerShell for the
 * `bash` tool on Windows, sh rules otherwise.
 */
export function commandSegments(
  command: string,
  dialect: CommandDialect = agentCommandShell().dialect
): string[] | null {
  return splitCommand(command, dialect)
}

/**
 * What the gate checks for a command: one resource per subcommand, all of which must be allowed, and the prefixes
 * "always" saves. An unreadable command becomes one resource that no saved rule covers, with nothing to save.
 */
export function commandPermission(
  command: string,
  dialect: CommandDialect = agentCommandShell().dialect
): { resources: string[]; save: string[] } {
  const segments = commandSegments(command, dialect)
  if (!segments) return { resources: [unparsedCommandResource(command)], save: [] }
  const resources = segments.length > 1 ? segments : [command]
  return { resources, save: [...new Set(resources.map(bashPermissionSavePattern))] }
}

async function run(args: z.infer<typeof params>, ctx: ToolContext, shell: CommandShell): Promise<BashResult> {
  const { abs: cwd, external } = resolveInside(ctx.cwd, args.workdir ?? '.')
  const stat = await fs.stat(cwd).catch(() => null)
  if (!stat?.isDirectory()) throw new Error(`Invalid directory: ${cwd}`)
  if (external) await ctx.ask('external_directory', [cwd], [cwd])
  // Chained command → one resource PER subcommand (all need allow); "always" saves each prefix.
  const { resources, save } = commandPermission(args.command, shell.dialect)
  await ctx.ask('bash', resources, save, args.command)

  const isWin = process.platform === 'win32'
  const powershell = shell.kind === 'powershell'
  const timeout = args.timeout ?? DEFAULT_TIMEOUT_MS

  return await new Promise<BashResult>((resolve, reject) => {
    // A fleet bot's commands open programs on its own display, session bus and browser.
    const env = { ...process.env, ...conversationShellEnv(ctx.conversationId) }
    const child = powershell
      ? spawn(shell.file, [...POWERSHELL_ARGS], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      : spawn(args.command, [], { cwd, shell: shell.file, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin })
    if (powershell) {
      // The command's own programs then read an empty stdin, as they do from the null device on other shells.
      child.stdin?.on('error', () => undefined)
      child.stdin?.end(args.command, 'utf8')
    }
    // `server &` returns at once and leaves the server in this group; it is ended with the conversation. Windows has
    // no process group to follow, so what a command leaves running there is not tracked.
    if (!isWin) trackCommandGroup(ctx.conversationId, child)
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
        if (isWin && child.pid)
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
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

function toModelText(_args: z.infer<typeof params>, r: BashResult): string {
  if (r.timedOut) return r.output
  const warn = r.truncated ? '\n\n(output truncated)' : ''
  return `${r.output}${warn}\n\nCommand exited with code ${r.exitCode ?? 'unknown'}.`
}

export const bashTool = defineTool({
  name: 'bash',
  // The name stays `bash` on every platform: saved permission rules and transcripts refer to it.
  description: bashToolDescription(),
  parameters: params,
  execute: (args, ctx) => run(args, ctx, agentCommandShell()),
  toModelText,
})

/** Runs a command in the system shell (cmd.exe on Windows) with the `bash` tool's permission gate and limits. */
export function runSystemShellCommand(args: z.infer<typeof params>, ctx: ToolContext): Promise<BashResult> {
  return run(args, ctx, systemCommandShell())
}
