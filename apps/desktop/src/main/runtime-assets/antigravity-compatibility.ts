import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AcpClient, type AcpClientOptions } from '../chat/acp/client'
import type { AcpInitializeResult } from '../chat/acp/protocol'
import { isRecord } from './npm-registry'
import { hostRuntimeTarget, type RuntimeAssetDefinition, type RuntimeTargetId } from './registry'

export const ANTIGRAVITY_COMPATIBILITY_REVISION = 1

/** Explicit allowlist: no inherited Google tokens, proxy settings, application credentials or personal config. */
export function antigravityValidationEnvironment(
  home: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    GEMINI_HOME: path.join(home, '.gemini'),
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_DATA_HOME: path.join(home, 'data'),
    APPDATA: path.join(home, 'config'),
    LOCALAPPDATA: path.join(home, 'data'),
    TMPDIR: path.join(home, 'tmp'),
    TMP: path.join(home, 'tmp'),
    TEMP: path.join(home, 'tmp'),
    PATH: process.platform === 'win32' ? `${inherited.SystemRoot ?? 'C:\\Windows'}\\System32` : '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
  }
  if (inherited.SystemRoot) env.SystemRoot = inherited.SystemRoot
  if (inherited.WINDIR) env.WINDIR = inherited.WINDIR
  return env
}

/**
 * Credential-free initialize checks wire version, agent identity/version, Google login, resume, image prompts
 * and HTTP MCP support as advertised by the server.
 * Session creation/resume, config/model selection, tool events and actual inference need authentication and
 * cannot be verified by this gate; initialize is not a claim that those authenticated contracts were exercised.
 */
export async function validateAntigravityRuntime(
  installationPath: string,
  definition: RuntimeAssetDefinition,
  signal: AbortSignal,
  dependencies: {
    readonly target?: RuntimeTargetId
    readonly timeoutMs?: number
    readonly inheritedEnv?: NodeJS.ProcessEnv
    readonly start?: (
      options: AcpClientOptions,
      signal: AbortSignal
    ) => Promise<{ client: Pick<AcpClient, 'close'>; initialize: AcpInitializeResult }>
  } = {}
): Promise<void> {
  signal.throwIfAborted()
  const target = dependencies.target ?? hostRuntimeTarget()
  const entry = definition.targets[target]
  const expectedExecutable = target.startsWith('win-') ? 'agy_acp_server.exe' : 'agy_acp_server.par'
  if (definition.id !== 'antigravity-acp-runtime' || entry?.executablePath !== expectedExecutable)
    throw new Error('Invalid Antigravity runtime layout')
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'maestrly-antigravity-validation-'))
  let client: Pick<AcpClient, 'close'> | undefined
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(dependencies.timeoutMs ?? 30_000)])
  try {
    const home = path.join(temporary, 'home')
    const cwd = path.join(temporary, 'scratch')
    await Promise.all(
      ['', 'tmp', 'config', 'cache', 'data'].map((part) =>
        mkdir(path.join(home, part), { recursive: true, mode: 0o700 })
      )
    )
    await mkdir(cwd, { mode: 0o700 })
    for (const executable of [
      entry.executablePath,
      target.startsWith('win-') ? 'localharness_external.exe' : 'localharness_external',
    ]) {
      await access(path.join(installationPath, executable), constants.X_OK)
    }
    deadline.throwIfAborted()
    const started = await (dependencies.start ?? AcpClient.start)(
      {
        command: path.join(installationPath, entry.executablePath),
        args: target.startsWith('linux-') ? ['--uid='] : [],
        cwd,
        env: antigravityValidationEnvironment(home, dependencies.inheritedEnv),
        clientInfo: { name: 'maestrly', version: 'runtime-validation' },
      },
      deadline
    )
    client = started.client
    const result = started.initialize
    const capabilities = result.agentCapabilities
    if (
      result.protocolVersion !== 1 ||
      result.agentInfo?.version !== definition.version ||
      result.agentInfo?.name !== 'antigravity-acp' ||
      !isRecord(capabilities) ||
      !isRecord(capabilities.promptCapabilities) ||
      capabilities.promptCapabilities.image !== true ||
      !isRecord(capabilities.mcpCapabilities) ||
      capabilities.mcpCapabilities.http !== true ||
      !isRecord(capabilities.sessionCapabilities) ||
      !isRecord(capabilities.sessionCapabilities.resume) ||
      !Array.isArray(result.authMethods) ||
      !result.authMethods.some((method) => method?.id === 'oauth-personal')
    )
      throw new Error('Incompatible Antigravity ACP initialize response')
    deadline.throwIfAborted()
  } finally {
    await client?.close(1_000).catch(() => undefined)
    await rm(temporary, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 })
  }
}
