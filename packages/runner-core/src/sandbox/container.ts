import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export interface ContainerLimits {
  cpus: number
  memoryMb: number
  pids: number
  timeoutSeconds: number
}

export class ContainerSandbox {
  constructor(readonly engine = 'docker', readonly image = 'maestrly/runner-executor:local') {}

  async doctor(): Promise<{ available: boolean; detail: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.engine, ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      let output = ''
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.once('error', (error) => resolve({ available: false, detail: error.message }))
      child.once('close', (code) => resolve({ available: code === 0, detail: code === 0 ? output.trim() : `${this.engine} exited with ${code}` }))
    })
  }

  argumentsFor(workspacePath: string, command: string[], limits: ContainerLimits): string[] {
    const resolved = path.resolve(workspacePath)
    const home = path.resolve(os.homedir())
    if (resolved === path.parse(resolved).root || resolved === home || home.startsWith(`${resolved}${path.sep}`) || resolved.length < 4) {
      throw new Error('Refusing to mount a broad workspace path.')
    }
    return [
      'run', '--rm', '--init', '--network', 'none', '--read-only',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--cpus', String(limits.cpus), '--memory', `${limits.memoryMb}m`, '--pids-limit', String(limits.pids),
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
      '--mount', `type=bind,src=${resolved},dst=/workspace`,
      '--workdir', '/workspace', this.image, ...command,
    ]
  }
}
