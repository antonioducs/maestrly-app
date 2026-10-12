import { spawn } from 'node:child_process'
import { commandShell } from '../chat/tools/bash'

const MAX_CAPTURE_BYTES = 1024 * 1024
const KILL_GRACE_MS = 2_000

export interface HookCommandResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Runs one plugin hook command: the shell the `bash` tool uses, the hook's input as JSON on stdin, stdout and stderr
 * captured up to 1 MiB each. A timeout or an abort stops the whole process group (SIGTERM, then SIGKILL).
 */
export function runHookCommand(args: {
  command: string
  cwd: string
  env: Record<string, string>
  stdin: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<HookCommandResult> {
  const isWin = process.platform === 'win32'
  return new Promise((resolve) => {
    const child = spawn(args.command, [], {
      cwd: args.cwd,
      shell: commandShell(),
      env: { ...process.env, ...args.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !isWin,
      windowsHide: true,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let settled = false
    const kill = () => {
      try {
        if (isWin && child.pid)
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        else if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        // Already exited.
      }
      setTimeout(() => {
        try {
          if (isWin) child.kill('SIGKILL')
          else if (child.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Already exited.
        }
      }, KILL_GRACE_MS).unref()
    }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      args.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      // A command that ignores SIGTERM is not waited for past the grace period.
      setTimeout(() => finish(null), KILL_GRACE_MS + 100).unref()
    }, args.timeoutMs)
    const onAbort = () => kill()
    args.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_CAPTURE_BYTES) return
      out.push(chunk.subarray(0, MAX_CAPTURE_BYTES - outBytes))
      outBytes += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes >= MAX_CAPTURE_BYTES) return
      err.push(chunk.subarray(0, MAX_CAPTURE_BYTES - errBytes))
      errBytes += chunk.length
    })
    child.on('error', (error) => {
      err.push(Buffer.from(String(error.message)))
      finish(null)
    })
    child.on('close', (code) => finish(timedOut ? null : code))
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(args.stdin)
  })
}
