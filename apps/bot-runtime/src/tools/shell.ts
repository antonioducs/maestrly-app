import { spawn } from 'node:child_process'
import type { ProcessRegistry } from '../turns/leases.js'
import { runtimeError } from '../turns/service.js'

export interface ShellContext {
  workspace: string
  turnId: string
  processes: ProcessRegistry
  signal?: AbortSignal
}
export function runInWorkspace(argv: string[], options: ShellContext & { timeoutMs?: number; maxOutput?: number }) {
  if (!argv.length || !argv[0] || argv.some((value) => value.includes('\0')))
    throw runtimeError('INVALID_COMMAND', 'Command argv required')
  options.signal?.throwIfAborted()
  return new Promise<{ output: string; exitCode: number | null; truncated: boolean }>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.workspace,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    const unregister = child.pid ? options.processes.register(options.turnId, child.pid) : () => {}
    let output = Buffer.alloc(0)
    let truncated = false
    let timedOut = false
    const collect = (chunk: Buffer) => {
      const remaining = (options.maxOutput ?? 64 * 1024) - output.length
      if (chunk.length > remaining) truncated = true
      output = Buffer.concat([output, chunk.subarray(0, Math.max(0, remaining))])
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const stop = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {}
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs ?? 300_000)
    options.signal?.addEventListener('abort', stop, { once: true })
    const cleanup = () => {
      clearTimeout(timer)
      unregister()
      options.signal?.removeEventListener('abort', stop)
    }
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('close', (exitCode) => {
      cleanup()
      if (timedOut) reject(runtimeError('TIMEOUT', 'Command timed out'))
      else if (options.signal?.aborted) reject(runtimeError('CANCELLED', 'Turn cancelled'))
      else resolve({ output: output.toString('utf8'), exitCode, truncated })
    })
  })
}
