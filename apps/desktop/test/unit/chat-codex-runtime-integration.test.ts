import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import {
  CODEX_LONG_CONTEXT_WINDOW_TOKENS,
  ensureNativeSubagentCatalogOverride,
  modelCatalogOverrideArgs,
  nativeSubagentSuppressionConfig,
  resetNativeSubagentCatalogOverrideCache,
} from '../../src/main/chat/codex-subscription/model-catalog-override'
import { codexRuntimeTarget, resolveCodexRuntime } from '../../src/main/chat/codex-subscription/runtime-resolver'
import {
  CODEX_HOST_MCP_SERVER_NAME,
  CODEX_HOST_MCP_TOKEN_ENV,
  closeCodexHostMcpServer,
  codexHostMcpProcessEnv,
  codexHostMcpThreadConfig,
  setCodexHostMcpCallHandler,
} from '../../src/main/chat/codex-subscription/host-mcp'

/**
 * Smoke test for the REAL official artifact installed by the @openai/codex optionalDependency.
 * Skipping optional-runtime tests keeps offline installs usable; the
 * packaging pipeline still fails closed through fetch-codex-runtime.mjs.
 */
const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const moduleRequire = createRequire(import.meta.url)
const target = (() => {
  try {
    return codexRuntimeTarget()
  } catch {
    return null
  }
})()
const optionalPackageJson = (() => {
  if (!target) return null
  try {
    return moduleRequire.resolve(`${target.optionalPackage}/package.json`)
  } catch {
    return null
  }
})()
const packageRoot = optionalPackageJson
  ? path.dirname(optionalPackageJson)
  : path.join(root, 'node_modules', '__missing__')
const expectedBinary = target ? path.join(packageRoot, 'vendor', target.targetTriple, 'bin', target.executableName) : ''

/** Minimal pinned-runtime model fields; production overrides copy official catalogs. */
function modelFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    multi_agent_version: 'v2',
    context_window: 272_000,
    max_context_window: 272_000,
    effective_context_window_percent: 95,
    supported_reasoning_levels: [
      { effort: 'low', description: 'fast' },
      { effort: 'ultra', description: 'max' },
    ],
    shell_type: 'default',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    base_instructions: 'You are Codex.',
    supports_reasoning_summaries: true,
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    ...overrides,
  }
}

describe.skipIf(!target || !existsSync(expectedBinary))('official Codex runtime', () => {
  it('resolves native optional executables instead of JS shims', () => {
    const result = resolveCodexRuntime({ isPackaged: false, resourcesPath: path.join(root, 'resources') })

    expect(result.source).toBe('node-modules')
    expect(result.executablePath).toBe(expectedBinary)
  })

  it('reports pinned versions and exposes app-server stdio', async () => {
    const version = await execFileAsync(expectedBinary, ['--version'], { timeout: 10_000 })
    expect(version.stdout.trim()).toBe('codex-cli 0.155.1')

    const help = await execFileAsync(expectedBinary, ['app-server', '--help'], { timeout: 10_000 })
    expect(help.stdout).toContain('Usage: codex app-server')
    expect(help.stdout).toContain('[default: stdio://]')
  }, 20_000)

  /**
   * Feature flags can report false while native spawn_agent remains available
   * because multi_agent_version is the real catalog gate. Only overrides remove
   * collaboration tools; verify this against the pinned binary.
   */
  it('neutralizes native multi-agent catalogs independently of feature flags', async () => {
    // Spaces reproduce Electron application-support paths.
    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'maestrly codex multiagent-'))
    try {
      const models = [modelFixture()]
      writeFileSync(
        path.join(codexHome, 'models_cache.json'),
        JSON.stringify({ fetched_at: new Date().toISOString(), client_version: '0.155.1', models }),
        'utf8'
      )
      const promptInput = async (extra: string[]): Promise<string> => {
        const result = await execFileAsync(
          expectedBinary,
          ['debug', 'prompt-input', '-c', 'model=gpt-5.6-sol', ...extra, 'hi'],
          { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CODEX_HOME: codexHome } }
        )
        return result.stdout
      }

      const features = await execFileAsync(
        expectedBinary,
        ['--disable', 'multi_agent', '--disable', 'multi_agent_v2', 'features', 'list'],
        { timeout: 10_000 }
      )
      expect(features.stdout).toMatch(/^multi_agent\s+stable\s+false$/m)
      expect(features.stdout).toMatch(/^multi_agent_v2\s+stable\s+false$/m)

      const withFlags = await promptInput(['--disable', 'multi_agent', '--disable', 'multi_agent_v2'])
      expect(withFlags).toContain('spawn_agent')

      const overridePath = await ensureNativeSubagentCatalogOverride(codexHome)
      expect(overridePath).toBe(path.join(codexHome, 'maestrly-model-catalog.json'))

      // Exactly the arguments the manager injects into the app-server process.
      const withOverride = await promptInput([...modelCatalogOverrideArgs(overridePath)])
      expect(withOverride).not.toContain('spawn_agent')
      expect(withOverride).not.toContain('multi_agent_mode')

      // The same catalog removes remote clamping; diagnostics separate bootstrap windows
      // published by the server and the cap loaded from the override, without model calls or quota consumption.
      const debugModels = await execFileAsync(
        expectedBinary,
        [
          'debug',
          'models',
          '-c',
          `model_context_window=${CODEX_LONG_CONTEXT_WINDOW_TOKENS}`,
          ...modelCatalogOverrideArgs(overridePath),
        ],
        { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CODEX_HOME: codexHome } }
      )
      const resolvedModels = JSON.parse(debugModels.stdout) as { models: Array<Record<string, unknown>> }
      expect(resolvedModels.models.find((model) => model.slug === 'gpt-5.6-sol')).toMatchObject({
        context_window: 272_000,
        max_context_window: CODEX_LONG_CONTEXT_WINDOW_TOKENS,
        effective_context_window_percent: 95,
      })

      // Thread hints only rewrite mode text.
      expect(nativeSubagentSuppressionConfig()).not.toHaveProperty('model_catalog_json')
    } finally {
      resetNativeSubagentCatalogOverrideCache(codexHome)
      rmSync(codexHome, { recursive: true, force: true })
    }
  }, 60_000)

  /**
   * Production regression: a newer Codex rewrote the app-owned
   * cache with a schema tolerated as cache but rejected as explicit catalog by 0.144.4
   * before initialization. Current runtimes accept that fixture,
   * but version gates remain because future compatibility is not guaranteed.
   */
  it('retains cross-version gates after upstream fixture corrections', async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'maestrly codex catalog-version-'))
    try {
      const runtimeVersion = resolveCodexRuntime({
        isPackaged: false,
        resourcesPath: path.join(root, 'resources'),
      }).version
      expect(runtimeVersion).toBe('0.155.1')

      // Use the exact field omission introduced by the historical 0.145.0 change.
      const { supports_reasoning_summaries: _dropped, ...futureModel } = modelFixture()
      const futureCatalog = JSON.stringify({
        fetched_at: new Date().toISOString(),
        client_version: '0.145.0',
        models: [futureModel],
      })
      writeFileSync(path.join(codexHome, 'models_cache.json'), futureCatalog, 'utf8')

      // The real binary confirms upstream fixed the historical case.
      const forcedPath = path.join(codexHome, 'forced-catalog.json')
      writeFileSync(forcedPath, futureCatalog, 'utf8')
      const accepted = await execFileAsync(
        expectedBinary,
        ['debug', 'prompt-input', '-c', 'model=gpt-5.6-sol', ...modelCatalogOverrideArgs(forcedPath), 'hi'],
        { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, CODEX_HOME: codexHome } }
      )
      expect(JSON.parse(accepted.stdout)).toEqual(expect.any(Array))

      // Still reject cross-version schemas because future versions may be incompatible.
      expect(await ensureNativeSubagentCatalogOverride(codexHome, {}, { runtimeVersion })).toBeNull()
      expect(existsSync(path.join(codexHome, 'maestrly-model-catalog.json'))).toBe(false)
    } finally {
      resetNativeSubagentCatalogOverrideCache(codexHome)
      rmSync(codexHome, { recursive: true, force: true })
    }
  }, 30_000)

  it('preserves deferred loading and namespaces in generated schemas', async () => {
    const output = mkdtempSync(path.join(os.tmpdir(), 'maestrly-codex-schema-'))
    try {
      await execFileAsync(expectedBinary, ['app-server', 'generate-json-schema', '--experimental', '--out', output], {
        timeout: 10_000,
      })
      const schema = JSON.parse(readFileSync(path.join(output, 'v2', 'ThreadStartParams.json'), 'utf8')) as {
        definitions?: {
          DynamicToolSpec?: {
            oneOf?: Array<{
              properties?: {
                deferLoading?: { type?: string }
                type?: { enum?: string[] }
                tools?: { type?: string }
              }
            }>
          }
        }
      }

      expect(schema.definitions?.DynamicToolSpec?.oneOf?.[0]?.properties?.deferLoading).toEqual({
        type: 'boolean',
      })
      expect(schema.definitions?.DynamicToolSpec?.oneOf?.[1]?.properties).toMatchObject({
        type: { enum: ['namespace'] },
        tools: { type: 'array' },
      })
    } finally {
      rmSync(output, { recursive: true, force: true })
    }
  }, 20_000)

  it('accepts deferred namespaced tools in real thread startup', async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'maestrly-codex-namespace-smoke-'))
    let client: CodexAppServerClient | null = null
    let threadId = ''
    try {
      client = await CodexAppServerClient.connect({
        binaryPath: expectedBinary,
        binaryArgs: ['app-server', '--disable', 'multi_agent', '--disable', 'multi_agent_v2'],
        clientInfo: { name: 'maestrly-test', title: 'Maestrly Test', version: '0.0.0' },
        capabilities: { experimentalApi: true },
        env: { CODEX_HOME: codexHome },
        unsetEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
        defaultRequestTimeoutMs: 10_000,
      })
      const started = await client.startThread({
        cwd: codexHome,
        ephemeral: true,
        environments: [],
        dynamicTools: [
          {
            type: 'namespace',
            name: 'maestrly_deferred',
            description: 'Maestrly tools discovered on demand.',
            tools: [
              {
                type: 'function',
                name: 'notes_append_page',
                description: 'Appends a notes page.',
                inputSchema: { type: 'object', properties: {} },
                deferLoading: true,
              },
            ],
          },
        ],
      } as Parameters<CodexAppServerClient['startThread']>[0] & {
        environments: []
        dynamicTools: unknown[]
      })
      threadId = started.thread.id
      expect(threadId).toEqual(expect.any(String))
    } finally {
      if (threadId) await client?.deleteThread({ threadId }).catch(() => undefined)
      await client?.close({ gracePeriodMs: 1_000 })
      rmSync(codexHome, { recursive: true, force: true })
    }
  }, 20_000)

  /**
   * Regression guard for runtime upgrades: Codex runs dynamic tools under a turn-wide write lock, so Maestrly
   * serves delegation from its host MCP server. A local fake Responses provider emits two `task` calls in one
   * response and then asks a shell command to report the token length; no credentials, network or quota are involved.
   */
  it('runs host MCP delegation in parallel, keeps it visible under tool search and hides its token', async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'maestrly-codex-host-mcp-'))
    const spans: Array<{ callId: string; start: number; end: number }> = []
    let requests = 0
    let firstRequestTools: unknown[] = []
    let envOutput = ''
    const usage = {
      input_tokens: 0,
      input_tokens_details: null,
      output_tokens: 0,
      output_tokens_details: null,
      total_tokens: 0,
    }
    const sse = (events: Array<Record<string, unknown>>): string =>
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    const taskCall = (callId: string, prompt: string) => ({
      type: 'response.output_item.done',
      item: {
        type: 'function_call',
        call_id: callId,
        namespace: `mcp__${CODEX_HOST_MCP_SERVER_NAME}`,
        name: 'task',
        arguments: JSON.stringify({ agent: 'explore', prompt }),
      },
    })
    const provider = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      req.on('end', () => {
        const parsed = JSON.parse(body) as { tools?: unknown[]; input?: Array<Record<string, unknown>> }
        requests += 1
        const id = `resp_${requests}`
        const events: Array<Record<string, unknown>> = [{ type: 'response.created', response: { id } }]
        // Decide by transcript content, not request count: the runtime may issue auxiliary requests.
        const outputFor = (callId: string) =>
          parsed.input?.find((item) => item.type === 'function_call_output' && item.call_id === callId)
        const envResult = outputFor('call_env')
        if (!outputFor('call_a') || !outputFor('call_b')) {
          if (!firstRequestTools.length) firstRequestTools = parsed.tools ?? []
          events.push(taskCall('call_a', 'first'), taskCall('call_b', 'second'))
        } else if (!envResult) {
          // Quote-free so POSIX shells and PowerShell pass it identically. Prints 0 when the token is blanked,
          // 64 when it leaks, and fails otherwise, so a command that never ran cannot pass as "no leak".
          const cmd = `node -p process.env.${CODEX_HOST_MCP_TOKEN_ENV}.length`
          events.push({
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: 'call_env',
              name: 'exec_command',
              arguments: JSON.stringify({ cmd }),
            },
          })
        } else {
          envOutput = typeof envResult.output === 'string' ? envResult.output : JSON.stringify(envResult.output)
          events.push({
            type: 'response.output_item.done',
            item: { type: 'message', role: 'assistant', id: 'msg', content: [{ type: 'output_text', text: 'done' }] },
          })
        }
        events.push({ type: 'response.completed', response: { id, usage } })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(sse(events))
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const providerPort = (provider.address() as { port: number }).port
    const catalogPath = path.join(codexHome, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify({ models: [modelFixture({ supports_search_tool: true })] }), 'utf8')
    writeFileSync(
      path.join(codexHome, 'config.toml'),
      [
        'model = "gpt-5.6-sol"',
        'model_provider = "mock"',
        '[model_providers.mock]',
        'name = "mock"',
        `base_url = "http://127.0.0.1:${providerPort}/v1"`,
        'wire_api = "responses"',
        'request_max_retries = 0',
        'stream_max_retries = 0',
      ].join('\n'),
      'utf8'
    )
    setCodexHostMcpCallHandler(async ({ callId }) => {
      const start = Date.now()
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      spans.push({ callId, start, end: Date.now() })
      return { content: [{ type: 'text', text: `result ${callId}` }] }
    })
    let client: CodexAppServerClient | null = null
    try {
      const threadConfig = await codexHostMcpThreadConfig({
        conversationId: 'runtime-integration',
        tools: [
          {
            name: 'task',
            description: 'Delegates a subtask.',
            inputSchema: {
              type: 'object',
              properties: { agent: { type: 'string' }, prompt: { type: 'string' } },
              required: ['agent', 'prompt'],
            },
          },
        ],
      })
      client = await CodexAppServerClient.connect({
        binaryPath: expectedBinary,
        binaryArgs: ['app-server', '-c', `model_catalog_json=${catalogPath}`],
        clientInfo: { name: 'maestrly-test', title: 'Maestrly Test', version: '0.0.0' },
        capabilities: { experimentalApi: true },
        env: { CODEX_HOME: codexHome, ...codexHostMcpProcessEnv() },
        unsetEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
        defaultRequestTimeoutMs: 20_000,
      })
      const completed = new Promise<void>((resolve) => {
        client!.onNotification(({ method }) => {
          if (method === 'turn/completed') resolve()
        })
      })
      const started = await client.startThread({
        cwd: codexHome,
        ephemeral: true,
        // Only Maestrly's environment policy is under test. OS sandboxes differ per CI host (bubblewrap cannot
        // configure loopback on GitHub Linux runners; Windows read-only policy rejects the shell outright).
        sandbox: 'danger-full-access',
        approvalPolicy: 'never',
        config: threadConfig,
      } as Parameters<CodexAppServerClient['startThread']>[0])
      await client.startTurn({
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'delegate twice', text_elements: [] }],
      } as Parameters<CodexAppServerClient['startTurn']>[0])
      await completed

      expect(firstRequestTools).toContainEqual(
        expect.objectContaining({
          type: 'namespace',
          name: `mcp__${CODEX_HOST_MCP_SERVER_NAME}`,
          tools: [expect.objectContaining({ name: 'task' })],
        })
      )
      expect(spans.map((span) => span.callId).sort()).toEqual(['call_a', 'call_b'])
      const [earlier, later] = [...spans].sort((a, b) => a.start - b.start)
      expect(later.start).toBeLessThan(earlier.end)
      expect(envOutput).not.toContain(codexHostMcpProcessEnv()[CODEX_HOST_MCP_TOKEN_ENV])
      expect(envOutput.trim().split(/\r?\n/).at(-1)?.trim()).toBe('0')
    } finally {
      setCodexHostMcpCallHandler(null)
      await client?.close({ gracePeriodMs: 1_000 })
      await closeCodexHostMcpServer()
      await new Promise<void>((resolve) => provider.close(() => resolve()))
      rmSync(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 60_000)

  it('completes isolated real app-server handshakes', async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), 'maestrly-codex-runtime-smoke-'))
    let client: CodexAppServerClient | null = null
    try {
      client = await CodexAppServerClient.connect({
        binaryPath: expectedBinary,
        binaryArgs: ['app-server', '--disable', 'multi_agent', '--disable', 'multi_agent_v2'],
        clientInfo: { name: 'maestrly-test', title: 'Maestrly Test', version: '0.0.0' },
        capabilities: { experimentalApi: true },
        env: { CODEX_HOME: codexHome },
        unsetEnv: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'],
        defaultRequestTimeoutMs: 10_000,
      })

      expect(client.state).toBe('ready')
      expect(client.initializeResult).toEqual(expect.any(Object))
    } finally {
      await client?.close({ gracePeriodMs: 1_000 })
      rmSync(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 20_000)
})
