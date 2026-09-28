import path from 'node:path'
import type { CommandRunner, RunOptions, RunResult } from '../../src/main/fleet/installer/runner'

type Reply = RunResult | ((args: string[], options?: RunOptions) => RunResult | Promise<RunResult>)

const composeProjectFlags = new Set(['--project-name', '--project-directory', '--file', '--env-file'])

/** The command a `docker` call runs, without the Compose project flags every installer command repeats. */
export function commandOf(args: string[]): string[] {
  if (args[0] !== 'compose') return args
  const command = ['compose']
  for (let index = 1; index < args.length; index++) {
    if (composeProjectFlags.has(args[index])) index++
    else command.push(args[index])
  }
  return command
}

export const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout, stderr })
export const fail = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr })

/**
 * A scripted `CommandRunner`: replies by command prefix (the most recent matching rule wins), records every call and
 * every file written. Unknown commands succeed with no output.
 */
export class FakeRunner implements CommandRunner {
  readonly calls: string[][] = []
  readonly inputs: Array<string | undefined> = []
  readonly files = new Map<string, string>()
  private readonly rules: Array<{ prefix: string[]; reply: Reply }> = []

  constructor(readonly kind: 'local' | 'remote' = 'local') {}

  on(prefix: string[], reply: Reply): this {
    this.rules.unshift({ prefix, reply })
    return this
  }

  /** The calls whose command starts with the prefix, without the Compose project flags. */
  commands(prefix: string[] = []): string[][] {
    return this.calls.map(commandOf).filter((command) => prefix.every((part, index) => command[index] === part))
  }

  async docker(args: string[], options?: RunOptions): Promise<RunResult> {
    this.calls.push(args)
    this.inputs.push(options?.input)
    const command = commandOf(args)
    const rule = this.rules.find(({ prefix }) => prefix.every((part, index) => command[index] === part))
    const result = rule ? (typeof rule.reply === 'function' ? await rule.reply(args, options) : rule.reply) : ok()
    if (options?.onLine)
      for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) if (line.trim()) options.onLine(line)
    return result
  }

  async writeFile(file: string, content: string): Promise<void> {
    this.files.set(file, content)
  }

  async readFile(file: string): Promise<string | null> {
    return this.files.get(file) ?? null
  }

  join(...parts: string[]): string {
    return path.posix.join(...parts)
  }
}
