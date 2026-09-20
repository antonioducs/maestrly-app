/**
 * Named project checks executed by the host.
 *
 * The model never supplies a command line: it names a configured check and the host resolves the program and
 * arguments. A check that writes to disk runs in a disposable copy of the revision under test, so the
 * implementer's workspace is not mutated by verification.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import {
  assertWorkspaceRelativePath,
  checkResultSchema,
  type CheckResult,
  type CodeRevision,
  type DelegationCheckConfig,
} from '@maestrly/protocol'
import { materializeReviewCopy, type ReviewCopy } from './delegation-snapshot'

export const MAX_CHECK_LOG_BYTES = 2 * 1024 * 1024

export interface CheckRunOutcome {
  result: CheckResult
  /** Captured output, already bounded. Truncation is reported in the result, never hidden. */
  log: Buffer
}

export interface CheckRunnerDeps {
  /** Workspace of the task; a mutating check receives a copy of this revision instead. */
  cwd: string
  revision: CodeRevision
  environment?: NodeJS.ProcessEnv
  reviewCopy?(input: { cwd: string; baseDirectory?: string }): Promise<ReviewCopy>
  copyBaseDirectory?: string
  run?: typeof execFile
}

function resolvedCommand(config: DelegationCheckConfig): string {
  return [config.command, ...config.args].join(' ').slice(0, 2000)
}

function scopedEnvironment(config: DelegationCheckConfig, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Only the allowlisted names are forwarded, plus the minimum a process needs to start.
  const allowed: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    TMPDIR: source.TMPDIR,
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
  }
  for (const name of config.environmentAllowlist) if (source[name] !== undefined) allowed[name] = source[name]
  return allowed
}

function execute(
  runner: typeof execFile,
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv }
): Promise<{ exitCode: number | null; output: Buffer; timedOut: boolean; failedToStart: string | null }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const child = runner(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs, env: options.env, maxBuffer: MAX_CHECK_LOG_BYTES, encoding: 'buffer' },
      (error, stdout, stderr) => {
        for (const part of [stdout, stderr]) {
          if (!part) continue
          const buffer = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
          if (bytes >= MAX_CHECK_LOG_BYTES) continue
          const slice = buffer.subarray(0, MAX_CHECK_LOG_BYTES - bytes)
          bytes += slice.byteLength
          chunks.push(slice)
        }
        const code = (error as NodeJS.ErrnoException & { code?: number | string } | null)?.code
        const killed = (error as { killed?: boolean } | null)?.killed === true
        resolve({
          exitCode: typeof child.exitCode === 'number' ? child.exitCode : typeof code === 'number' ? code : error ? 1 : 0,
          output: Buffer.concat(chunks),
          timedOut: killed || (error as { signal?: string } | null)?.signal === 'SIGTERM',
          failedToStart: code === 'ENOENT' ? `The check program "${command}" is not installed on this computer.` : null,
        })
      }
    )
  })
}

/**
 * Run one configured check against a captured revision. The host records the resolved command, the exit code
 * and the revision under test; a model's claim that "the tests pass" is never used as evidence.
 */
export async function runNamedCheck(config: DelegationCheckConfig, deps: CheckRunnerDeps): Promise<CheckRunOutcome> {
  const runner = deps.run ?? execFile
  const started = Date.now()
  const relative = config.workingDirectory ? assertWorkspaceRelativePath(config.workingDirectory) : ''
  let copy: ReviewCopy | null = null
  try {
    const base = config.mutatesWorkspace
      ? (copy = await (deps.reviewCopy ?? materializeReviewCopy)({
          cwd: deps.cwd,
          baseDirectory: deps.copyBaseDirectory,
        })).path
      : deps.cwd
    const cwd = relative ? path.join(base, relative) : base
    const environment = scopedEnvironment(config, deps.environment ?? process.env)

    for (const step of config.setup) {
      const [program, ...args] = step.split(/\s+/)
      const setup = await execute(runner, program!, args, {
        cwd,
        timeoutMs: config.timeoutSeconds * 1000,
        env: environment,
      })
      if (setup.failedToStart || setup.exitCode !== 0)
        return {
          log: setup.output,
          result: checkResultSchema.parse({
            checkId: config.id,
            resolvedCommand: step,
            passed: false,
            exitCode: setup.exitCode,
            durationMs: Date.now() - started,
            timedOut: setup.timedOut,
            truncated: setup.output.byteLength >= MAX_CHECK_LOG_BYTES,
            codeRevisionDigest: deps.revision.contentDigest,
            logArtifactId: null,
            // An incomplete setup blocks the validation explicitly instead of failing silently.
            setupIssue: setup.failedToStart ?? `The setup step "${step}" exited with ${setup.exitCode}.`,
          }),
        }
    }

    const outcome = await execute(runner, config.command, config.args, {
      cwd,
      timeoutMs: config.timeoutSeconds * 1000,
      env: environment,
    })
    return {
      log: outcome.output,
      result: checkResultSchema.parse({
        checkId: config.id,
        resolvedCommand: resolvedCommand(config),
        passed: !outcome.failedToStart && !outcome.timedOut && outcome.exitCode === 0,
        exitCode: outcome.exitCode,
        durationMs: Date.now() - started,
        timedOut: outcome.timedOut,
        truncated: outcome.output.byteLength >= MAX_CHECK_LOG_BYTES,
        codeRevisionDigest: deps.revision.contentDigest,
        logArtifactId: null,
        setupIssue: outcome.failedToStart,
      }),
    }
  } finally {
    await copy?.dispose()
  }
}
