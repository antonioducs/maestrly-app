import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_SUBSCRIPTION_APP_SERVER_ARGS,
  CODEX_SUBSCRIPTION_UNSET_ENV,
  CODEX_SUBSCRIPTION_UNSET_ENV_PREFIXES,
} from '../chat/codex-subscription/app-server-contract'
import { CodexAppServerClient, type CodexAppServerConnectOptions } from '../chat/codex-subscription/client'
import {
  ensureNativeSubagentCatalogOverride,
  modelCatalogOverrideArgs,
  resetNativeSubagentCatalogOverrideCache,
} from '../chat/codex-subscription/model-catalog-override'
import { CODEX_TARGET_LAYOUT, hostRuntimeTarget, type RuntimeAssetDefinition, type RuntimeTargetId } from './registry'

/**
 * Local compatibility gate for a candidate Codex release, run against the staged installation before activation.
 * It exercises only the contracts Maestrly depends on, in an isolated temporary CODEX_HOME without credentials
 * or personal configuration, and never sends a model turn:
 *
 * - native layout manifest and the version reported by the executable;
 * - the runtime's own bundled catalog turned into the neutralized `model_catalog_json` override exactly as the
 *   manager does, and native sub-agent tools absent from the rendered prompt;
 * - an `app-server` started with production arguments: handshake, `model/list`, and an ephemeral
 *   `thread/start` registering deferred namespaced dynamic tools.
 *
 * Increase `CODEX_COMPATIBILITY_REVISION` whenever this contract changes so validations recorded by older builds
 * are repeated before the runtime is trusted again.
 */
export const CODEX_COMPATIBILITY_REVISION = 1
export const CODEX_VALIDATION_TIMEOUT_MS = 90_000
const STEP_TIMEOUT_MS = 20_000
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const NATIVE_SUBAGENT_TOOLS = ['spawn_agent', 'wait_agent', 'send_message', 'followup_task']

export class CodexCompatibilityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CodexCompatibilityError'
  }
}

export type CodexExecFile = (
  file: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv
    readonly cwd: string
    readonly signal: AbortSignal
    readonly timeout: number
    readonly maxBuffer: number
  }
) => Promise<{ readonly stdout: string; readonly stderr: string }>

export interface CodexCompatibilityDependencies {
  readonly target?: RuntimeTargetId
  readonly execFile?: CodexExecFile
  readonly connect?: (options: CodexAppServerConnectOptions) => Promise<CodexAppServerClient>
  readonly tempRoot?: string
  readonly timeoutMs?: number
  readonly clientVersion?: string
}

const defaultExecFile: CodexExecFile = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }))
      else resolve({ stdout, stderr })
    })
  })

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function describe(error: unknown): string {
  const detail = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim().split('\n').pop() : ''
  const base = error instanceof Error ? error.message : String(error)
  return detail ? `${base}: ${detail.slice(0, 400)}` : base
}

/** Same environment policy as the manager: inherited Codex/OpenAI variables never reach the runtime. */
function isolatedEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const unset = new Set<string>(CODEX_SUBSCRIPTION_UNSET_ENV)
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase()
    if (unset.has(upper) || CODEX_SUBSCRIPTION_UNSET_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue
    env[name] = value
  }
  env.CODEX_HOME = codexHome
  return env
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CodexCompatibilityError) throw error
    throw new CodexCompatibilityError(`${name} failed: ${describe(error)}`, { cause: error })
  }
}

export async function validateCodexRuntime(
  installationPath: string,
  definition: RuntimeAssetDefinition,
  signal: AbortSignal,
  dependencies: CodexCompatibilityDependencies = {}
): Promise<void> {
  const targetId = dependencies.target ?? hostRuntimeTarget()
  const target = definition.targets[targetId]
  const layout = CODEX_TARGET_LAYOUT[targetId]
  if (!target?.executablePath || !layout) {
    throw new CodexCompatibilityError(`Codex ${definition.version} has no ${targetId} executable contract`)
  }
  const run = dependencies.execFile ?? defaultExecFile
  const connect = dependencies.connect ?? ((options) => CodexAppServerClient.connect(options))
  const deadline = AbortSignal.timeout(dependencies.timeoutMs ?? CODEX_VALIDATION_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, deadline])
  const executable = path.join(installationPath, ...target.executablePath.split('/'))
  const version = definition.version

  await step('Native manifest check', async () => {
    const manifest: unknown = JSON.parse(await readFile(path.join(installationPath, 'codex-package.json'), 'utf8'))
    if (
      !isRecord(manifest) ||
      manifest.layoutVersion !== 1 ||
      manifest.version !== version ||
      manifest.target !== layout.triple ||
      manifest.entrypoint !== target.executablePath
    ) {
      throw new CodexCompatibilityError(`Native manifest does not describe Codex ${version} for ${layout.triple}`)
    }
  })

  const temporary = await mkdtemp(path.join(dependencies.tempRoot ?? os.tmpdir(), 'maestrly-codex-validate-'))
  const codexHome = path.join(temporary, 'home')
  let client: CodexAppServerClient | null = null
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 })
    const env = isolatedEnvironment(codexHome)
    const exec = (args: readonly string[]) =>
      run(executable, args, {
        env,
        cwd: temporary,
        signal: combined,
        timeout: STEP_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      })

    await step('Version check', async () => {
      const reported = (await exec(['--version'])).stdout.trim()
      if (reported !== `codex-cli ${version}`) {
        throw new CodexCompatibilityError(`Executable reports "${reported}" instead of codex-cli ${version}`)
      }
    })

    const models = await step('Bundled catalog check', async () => {
      const parsed: unknown = JSON.parse((await exec(['debug', 'models', '--bundled'])).stdout)
      if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) {
        throw new CodexCompatibilityError('Bundled model catalog is empty or malformed')
      }
      return parsed.models as unknown[]
    })

    // Generate the neutralized catalog from the runtime's OWN schema, exactly like a production cold start.
    const overridePath = await step('Sub-agent catalog override', async () => {
      await writeFile(
        path.join(codexHome, 'models_cache.json'),
        JSON.stringify({ fetched_at: new Date().toISOString(), client_version: version, models }),
        { encoding: 'utf8', mode: 0o600 }
      )
      const generated = await ensureNativeSubagentCatalogOverride(codexHome, {}, { runtimeVersion: version })
      if (!generated) throw new CodexCompatibilityError('Neutralized model catalog could not be generated')
      return generated
    })
    const catalogArgs = modelCatalogOverrideArgs(overridePath)
    const flags = CODEX_SUBSCRIPTION_APP_SERVER_ARGS.slice(1)

    const multiAgentModel = models.find(
      (model): model is Record<string, unknown> =>
        isRecord(model) && typeof model.slug === 'string' && Boolean(model.multi_agent_version)
    )
    if (multiAgentModel) {
      await step('Sub-agent suppression check', async () => {
        const prompt = await exec([
          'debug',
          'prompt-input',
          ...flags,
          '-c',
          `model=${String(multiAgentModel.slug)}`,
          ...catalogArgs,
          'hi',
        ])
        const leaked = NATIVE_SUBAGENT_TOOLS.find((tool) => prompt.stdout.includes(tool))
        if (leaked) throw new CodexCompatibilityError(`Neutralized catalog still exposes native ${leaked}`)
      })
    }

    client = await step('App-server handshake', () =>
      connect({
        binaryPath: executable,
        binaryArgs: [...CODEX_SUBSCRIPTION_APP_SERVER_ARGS, ...catalogArgs],
        clientInfo: {
          name: 'maestrly',
          title: 'Maestrly',
          version: dependencies.clientVersion ?? 'runtime-validation',
        },
        capabilities: { experimentalApi: true },
        cwd: temporary,
        env: { CODEX_HOME: codexHome },
        unsetEnv: CODEX_SUBSCRIPTION_UNSET_ENV,
        unsetEnvPrefixes: CODEX_SUBSCRIPTION_UNSET_ENV_PREFIXES,
        signal: combined,
        defaultRequestTimeoutMs: STEP_TIMEOUT_MS,
      })
    )
    const active = client

    await step('Model listing', async () => {
      const page = await active.request<unknown>(
        'model/list',
        { limit: 100, includeHidden: false },
        { signal: combined }
      )
      if (
        !isRecord(page) ||
        !Array.isArray(page.data) ||
        page.data.some((model) => !isRecord(model) || (typeof model.id !== 'string' && typeof model.model !== 'string'))
      ) {
        throw new CodexCompatibilityError('model/list returned an incompatible page')
      }
    })

    await step('Dynamic tool registration', async () => {
      const started = await active.startThread(
        {
          cwd: temporary,
          ephemeral: true,
          environments: [],
          dynamicTools: [
            {
              type: 'namespace',
              name: 'maestrly_validation',
              description: 'Maestrly compatibility probe.',
              tools: [
                {
                  type: 'function',
                  name: 'probe',
                  description: 'Compatibility probe; never invoked.',
                  inputSchema: { type: 'object', properties: {} },
                  deferLoading: true,
                },
              ],
            },
          ],
        } as Parameters<CodexAppServerClient['startThread']>[0] & { environments: []; dynamicTools: unknown[] },
        { signal: combined }
      )
      const threadId = isRecord(started) && isRecord(started.thread) ? started.thread.id : undefined
      if (typeof threadId !== 'string' || !threadId) {
        throw new CodexCompatibilityError('thread/start did not return a thread id')
      }
      await active.deleteThread({ threadId }, { signal: combined }).catch(() => undefined)
    })
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    if (deadline.aborted && !(error instanceof CodexCompatibilityError && !combined.aborted)) {
      throw new CodexCompatibilityError('Codex runtime validation timed out', { cause: error })
    }
    throw error
  } finally {
    await client?.close({ gracePeriodMs: 1_000 }).catch(() => undefined)
    resetNativeSubagentCatalogOverrideCache(codexHome)
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
  }
}
