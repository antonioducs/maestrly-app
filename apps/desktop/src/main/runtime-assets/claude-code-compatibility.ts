import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { claudeSubscriptionRuntimeEnvironment } from '../chat/claude-agent-sdk/runtime-env'
import { isCompatibleClaudeCodeVersion } from '../chat/claude-agent-sdk/version'
import type { RuntimeAssetDefinition } from './registry'

/** Bump when the checks below change: accepted releases are revalidated against the new contract. */
export const CLAUDE_CODE_COMPATIBILITY_REVISION = 1
export const CLAUDE_CODE_VALIDATION_TIMEOUT_MS = 60_000

export interface ClaudeCodeCompatibilityDependencies {
  readonly execFile?: (
    file: string,
    args: string[],
    options: { env: Record<string, string>; signal: AbortSignal }
  ) => Promise<{ stdout: string; stderr: string }>
  readonly queryFactory?: (params: {
    prompt: AsyncIterable<SDKUserMessage>
    options?: Options
  }) => Pick<Query, 'initializationResult' | 'supportedModels' | 'close'>
  readonly tempRoot?: string
  readonly timeoutMs?: number
}

const execFileAsync = promisify(execFileCallback)

async function defaultExecFile(
  file: string,
  args: string[],
  options: { env: Record<string, string>; signal: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args, {
    env: options.env,
    signal: options.signal,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024,
  })
  return { stdout, stderr }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * Checks a staged Claude Code release before it becomes active, without credentials and without a model turn: the
 * binary reports the expected version, that version is one the Agent SDK integration supports, and an SDK session
 * started on it completes the handshake and lists models. The session runs in a temporary profile with only the
 * operational environment, so no account, API key or setting of this process reaches it.
 */
export async function validateClaudeCodeRuntime(
  installationPath: string,
  definition: RuntimeAssetDefinition,
  signal: AbortSignal,
  dependencies: ClaudeCodeCompatibilityDependencies = {}
): Promise<void> {
  const timeoutMs = dependencies.timeoutMs ?? CLAUDE_CODE_VALIDATION_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  const execFile = dependencies.execFile ?? defaultExecFile
  const queryFactory = dependencies.queryFactory ?? query
  const executable = path.join(installationPath, 'claude')
  const home = await mkdtemp(path.join(dependencies.tempRoot ?? os.tmpdir(), 'maestrly-claude-validate-'))
  let release: (() => void) | undefined
  let session: Pick<Query, 'initializationResult' | 'supportedModels' | 'close'> | null = null
  try {
    const env = claudeSubscriptionRuntimeEnvironment(path.join(home, '.claude'), {
      PATH: process.env.PATH,
      HOME: home,
    })
    const { stdout } = await execFile(executable, ['--version'], { env, signal: combined })
    const reported = stdout.trim()
    const expected = `${definition.version} (Claude Code)`
    if (reported !== expected) throw new Error(`Claude Code reported "${reported}" instead of "${expected}"`)
    if (!isCompatibleClaudeCodeVersion(definition.version)) {
      throw new Error(`Claude Code ${definition.version} is incompatible with this Agent SDK integration`)
    }

    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // An open prompt keeps the session alive for the control requests; it never sends a user message.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      await held
    }
    session = queryFactory({
      prompt: prompt(),
      options: {
        pathToClaudeCodeExecutable: executable,
        env,
        cwd: home,
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        permissionMode: 'dontAsk',
        persistSession: false,
        systemPrompt: 'Maestrly runtime validation.',
      },
    })
    await abortable(session.initializationResult(), combined)
    const models = await abortable(session.supportedModels(), combined)
    if (!models.length) throw new Error(`Claude Code ${definition.version} listed no model`)
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    if (timeout.aborted) {
      throw new Error(`Claude Code ${definition.version} validation timed out after ${timeoutMs} ms`, { cause: error })
    }
    throw error
  } finally {
    release?.()
    try {
      session?.close()
    } catch {
      // The session is being discarded either way.
    }
    await rm(home, { recursive: true, force: true })
  }
}
