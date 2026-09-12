import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import type { ExecutionContext, ExecutionHandle, ExecutionOutcome } from '../executor.js'
import { ContainerSandbox } from './container.js'
export interface CommandRunner {
  available(): Promise<boolean>
  start(context: ExecutionContext, command: string): Promise<ExecutionHandle>
}
export class ContainerCommandRunner implements CommandRunner {
  constructor(
    private readonly image: string,
    private readonly executable = 'docker'
  ) {}
  async available() {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(this.image)) return false
    try {
      await promisify(execFile)(this.executable, ['image', 'inspect', this.image], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      })
      return true
    } catch {
      return false
    }
  }
  async start(context: ExecutionContext, command: string): Promise<ExecutionHandle> {
    if (!(await this.available())) throw new Error('The approved command sandbox image is unavailable.')
    const name = 'maestrly-pre-' + randomUUID()
    const sandbox = new ContainerSandbox(this.executable, this.image)
    const args = sandbox.argumentsFor(context.environment.workspacePath, ['-eu', '-c', command], {
      cpus: 2,
      memoryMb: 1024,
      pids: 128,
      timeoutSeconds: context.envelope.snapshot.maxDurationSeconds ?? 3600,
    })
    args.splice(
      1,
      0,
      '--entrypoint',
      '/bin/sh',
      '--name',
      name,
      '--pull',
      'never',
      '--env',
      'HOME=/tmp',
      '--user',
      String(process.getuid?.() ?? 1000) + ':' + String(process.getgid?.() ?? 1000)
    )
    if (context.signal?.aborted) throw new Error('Execution cancelled before pre-command startup.')
    const child = spawn(this.executable, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true })
    let cancelled = false
    const done = new Promise<ExecutionOutcome>((resolve, reject) => {
      child.stdout.on('data', (chunk) => {
        void context
          .emit({ type: 'pre_command.stdout', data: { text: String(chunk).slice(0, 16384) } })
          .catch(() => undefined)
      })
      child.stderr.on('data', (chunk) => {
        void context
          .emit({ type: 'pre_command.stderr', data: { text: String(chunk).slice(0, 16384) } })
          .catch(() => undefined)
      })
      child.once('error', reject)
      child.once('close', (code) =>
        resolve(
          cancelled
            ? { state: 'cancelled' }
            : code === 0
              ? { state: 'succeeded' }
              : { state: 'failed', failure: 'Pre-command exited with status ' + code }
        )
      )
    })
    return {
      done,
      cancel: async () => {
        cancelled = true
        await promisify(execFile)(this.executable, ['rm', '-f', name], { timeout: 10000 }).catch(() => undefined)
        child.kill('SIGTERM')
        await done
      },
    }
  }
}
