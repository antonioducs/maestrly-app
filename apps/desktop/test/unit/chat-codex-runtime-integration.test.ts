import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { CodexAppServerClient } from '../../src/main/chat/codex-subscription/client'
import { dynamicToolRegistrations } from '../../src/main/chat/codex-subscription/dynamic-tools'
import {
  CODEX_LONG_CONTEXT_WINDOW_TOKENS,
  ensureNativeSubagentCatalogOverride,
  modelCatalogOverrideArgs,
  nativeSubagentSuppressionConfig,
  resetNativeSubagentCatalogOverrideCache,
} from '../../src/main/chat/codex-subscription/model-catalog-override'
import { codexRuntimeTarget, resolveCodexRuntime } from '../../src/main/chat/codex-subscription/runtime-resolver'

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
  it('forwards deferred tool images from exec to the next model request', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'maestrly-codex-image-probe-'))
    const imageUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdLep8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3IPanc8OLDQitxAAAAAElFTkSuQmCC'
    type FixtureRequest = {
      input: Array<{
        type?: string
        output?: string | Array<{ type: string; text?: string; image_url?: string }>
      }>
      tools: Array<{ name?: string; description?: string }>
    }
    const requests: FixtureRequest[] = []
    const toolCalls: unknown[] = []
    const discovery = `text(ALL_TOOLS.find((tool) => tool.name.endsWith('__browser_screenshot'))?.description)`
    const forwardImage = `const result = await tools.maestrly_deferred__browser_screenshot({}); const urls = result.match(/data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g) ?? []; for (const url of urls) image(url); text(JSON.stringify({type:typeof result, prefix:result.slice(0, 13)})); text(result.replace(/data:image\\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '').trim());`
    const naturalGuess = `const shot = await tools.maestrly_deferred__browser_screenshot({}); for (const c of (shot?.content ?? [])) c.type === 'image' ? image(c) : c.type === 'text' ? text(c.text) : null;`
    const server = createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      if (request.url?.includes('/responses')) {
        const input = JSON.parse(body) as FixtureRequest
        requests.push(input)
        const index = requests.length
        const priorOutput = [...input.input].reverse().find((item) => item.type === 'custom_tool_call_output')?.output
        const toolDescription = Array.isArray(priorOutput) ? priorOutput.map((item) => item.text ?? '').join('\n') : ''
        const code = index === 1 ? discovery : toolDescription.includes('call image(url)') ? forwardImage : naturalGuess
        const item =
          index < 3
            ? {
                id: `call_${index}`,
                type: 'custom_tool_call',
                call_id: `call_${index}`,
                name: 'exec',
                input: code,
                status: 'completed',
              }
            : {
                id: `msg_${index}`,
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                content: [{ type: 'output_text', text: 'done', annotations: [] }],
                status: 'completed',
              }
        const events = [
          {
            type: 'response.created',
            response: { id: `resp_${index}`, created_at: index, model: 'gpt-6-luna', service_tier: null },
          },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: `resp_${index}`,
              output: [item],
              incomplete_details: null,
              usage: {
                input_tokens: 20,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 10,
                output_tokens_details: { reasoning_tokens: 0 },
              },
              service_tier: 'default',
            },
          },
        ]
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`)
      } else response.writeHead(404).end()
    })
    let client: CodexAppServerClient | null = null
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      writeFileSync(
        path.join(home, 'config.toml'),
        `[features]\ncode_mode = true\ncode_mode_host = true\ncode_mode_only = true\n\n[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n`,
        'utf8'
      )
      writeFileSync(
        path.join(home, 'models_cache.json'),
        JSON.stringify({
          fetched_at: new Date().toISOString(),
          client_version: '0.155.1',
          models: [modelFixture({ slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', tool_mode: 'code_mode_only' })],
        }),
        'utf8'
      )
      client = await CodexAppServerClient.connect({
        binaryPath: expectedBinary,
        binaryArgs: ['app-server', '--disable', 'multi_agent', '--disable', 'multi_agent_v2'],
        clientInfo: { name: 'maestrly-test', title: 'Maestrly Test', version: '0.0.0' },
        capabilities: { experimentalApi: true },
        env: { CODEX_HOME: home, OPENAI_API_KEY: 'fixture-key' },
        defaultRequestTimeoutMs: 10000,
        serverRequestHandler: (request) => {
          toolCalls.push(request)
          return {
            contentItems: [
              { type: 'inputText', text: 'Mouse at 0, 0' },
              { type: 'inputImage', imageUrl },
            ],
            success: true,
          }
        },
      })
      const started = await client.startThread({
        cwd: home,
        model: 'gpt-6-luna',
        modelProvider: 'fixture',
        ephemeral: true,
        dynamicTools: dynamicToolRegistrations([
          {
            type: 'function',
            name: 'browser_screenshot',
            description: 'Capture screenshot.',
            inputSchema: { type: 'object', properties: {} },
            deferLoading: true,
          },
        ]),
      } as Parameters<CodexAppServerClient['startThread']>[0] & { dynamicTools: unknown[] })
      const completed = new Promise<void>((resolve) =>
        client!.onNotification((n) => {
          if (n.method === 'turn/completed') resolve()
        })
      )
      await client.startTurn({
        threadId: started.thread.id,
        input: [{ type: 'text', text: 'capture', text_elements: [] }],
        model: 'gpt-6-luna',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      })
      await Promise.race([completed, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))])
      expect(requests.length).toBeGreaterThanOrEqual(3)
      expect(requests[0]?.tools.find((tool) => tool.name === 'exec')?.description).toContain(
        'image(imageUrlOrItem: string'
      )
      expect(requests[0]?.tools.find((tool) => tool.name === 'exec')?.description).toContain('text(value: string')
      expect(toolCalls).toHaveLength(1)
      expect(requests[2]?.input.at(-1)?.output).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'input_image', image_url: imageUrl })])
      )
      expect(requests[2]?.input.at(-1)?.output).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'input_text', text: expect.stringContaining('"type":"string"') }),
        ])
      )
    } finally {
      await client?.close({ gracePeriodMs: 1000 })
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(home, { recursive: true, force: true })
    }
  }, 30000)
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
      expect(schema.definitions?.DynamicToolSpec?.oneOf?.[0]?.properties).not.toHaveProperty('outputSchema')
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
