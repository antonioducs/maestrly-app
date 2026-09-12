import { describe, expect, it, vi } from 'vitest'
import { createChatGptWebBridge, type BridgeDelivery } from '../../src/main/chat/chatgpt-web/bridge-server'
import { createBridgeRouter } from '../../src/main/chat/chatgpt-web/bridge-router'
import {
  CHATGPT_WEB_TOOL_CATALOG_META_KEY,
  CHATGPT_WEB_TOOL_CATALOG_VERSION,
} from '../../src/main/chat/chatgpt-web/bridge-protocol'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/** Deterministic fake controller; real behavior is tested separately. */
function fakeLoop(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(async () => ({
      loopId: 'rl_test',
      status: 'reviewing',
      iteration: 1,
      maxIterations: 5,
      severityThreshold: 'important',
      baseline: { branch: 'main', head: 'abc', workspaceFingerprint: 'fp' },
      executor: { providerId: 'builtin_codex', modelId: 'gpt-5.6' },
    })),
    submit: vi.fn(async () => ({ loopId: 'rl_test', jobId: 'j_1', iteration: 1, status: 'running', startedAt: 1 })),
    wait: vi.fn(async () => ({
      status: 'completed',
      iteration: 1,
      startedAt: 1,
      finishedAt: 2,
      madeProgress: true,
      beforeFingerprint: 'fp-b',
      afterFingerprint: 'fp-a',
      nextIteration: 2,
      canContinue: true,
    })),
    finish: vi.fn(async () => ({
      loopId: 'rl_test',
      result: 'clean',
      iterations: 2,
      durationMs: 100,
      startedAt: 1,
      finishedAt: 101,
      baselineFingerprint: 'fp',
      finalFingerprint: 'fp2',
      finishReason: 'clean',
    })),
    cancel: vi.fn(),
    info: vi.fn(() => null),
    activeLoopId: vi.fn(() => null),
    getState: vi.fn(() => null),
    ...overrides,
  }
}

async function callRouter(
  router: ReturnType<typeof createBridgeRouter>,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const response = (await router.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result: ToolResult }
  return response.result
}

function bridge(label: string, overrides: Partial<Parameters<typeof createChatGptWebBridge>[0]> = {}) {
  return createChatGptWebBridge({
    cwd: process.cwd(),
    runGit: async () => label,
    ...overrides,
  })
}

describe('multi-session companion router', () => {
  it('publishes one gateway catalog version bump', () => {
    expect(CHATGPT_WEB_TOOL_CATALOG_VERSION).toBe('11')
  })
  it('supports stateless MCP discovery probes', async () => {
    const router = createBridgeRouter()
    const response = (await router.handleMessage({
      jsonrpc: '2.0',
      id: 'openai-mcp-discover',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'openai-mcp', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    })) as {
      id: string
      result: {
        resultType: string
        supportedVersions: string[]
        capabilities: { tools?: object }
        instructions: string
        ttlMs: number
        cacheScope: string
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: string } }
      }
    }

    expect(response.id).toBe('openai-mcp-discover')
    expect(response.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: ['2026-07-28', '2025-06-18'],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: 'private',
    })
    expect(response.result.instructions).toContain('send_to_maestrly')
    expect(response.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('maestrly-bridge')
    expect(router.size()).toBe(0)
  })

  it('does not negotiate stateless revision through legacy initialize', async () => {
    const router = createBridgeRouter()
    const response = (await router.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2026-07-28' },
    })) as { result: { protocolVersion: string } }
    expect(response.result.protocolVersion).toBe('2025-06-18')
  })

  it('handles initialize and tools/list without a setup session', async () => {
    const router = createBridgeRouter()
    const init = (await router.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })) as { result: { instructions: string } }
    expect(init.result.instructions).toContain('send_to_maestrly')
    expect(init.result.instructions).not.toContain('next_input')

    const list = (await router.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(list.result.tools.some((tool) => tool.name === 'send_to_maestrly')).toBe(true)
    // Static catalogs announce every capability, including review loops.
    for (const name of ['start_review_loop', 'submit_review_fix', 'wait_review_fix', 'finish_review_loop']) {
      expect(list.result.tools.some((tool) => tool.name === name)).toBe(true)
    }
    expect(list.result.tools.some((tool) => tool.name === 'get_context')).toBe(true)
    for (const name of ['get_conversation_context', 'search_conversation', 'read_conversation']) {
      expect(list.result.tools.some((tool) => tool.name === name)).toBe(true)
    }
    expect(list.result.tools.some((tool) => tool.name === 'read_file')).toBe(true)
    expect(list.result.tools.some((tool) => tool.name.startsWith('board_'))).toBe(false)
    expect(router.size()).toBe(0)
  })

  it('tracks catalog upgrades and preserves current sessions', async () => {
    const refreshed = vi.fn()
    const router = createBridgeRouter({
      lastRefreshedToolCatalogVersion: '1',
      onToolCatalogRefreshed: refreshed,
    })

    expect(router.catalogStatus()).toEqual({ version: CHATGPT_WEB_TOOL_CATALOG_VERSION, appRefreshRequired: true })
    router.register('stale-session', bridge('stale'))
    expect(router.appRefreshRequired()).toBe(true)

    const list = (await router.handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string }>; _meta: Record<string, string> }
    }
    expect(list.result._meta[CHATGPT_WEB_TOOL_CATALOG_META_KEY]).toBe(CHATGPT_WEB_TOOL_CATALOG_VERSION)
    expect(list.result.tools.some((tool) => tool.name === 'notify_turn_complete')).toBe(true)
    expect(router.catalogStatus()).toEqual({ version: CHATGPT_WEB_TOOL_CATALOG_VERSION, appRefreshRequired: false })
    expect(refreshed).toHaveBeenCalledOnce()
    expect(refreshed).toHaveBeenCalledWith(CHATGPT_WEB_TOOL_CATALOG_VERSION)

    router.unregister('stale-session')
    router.register('already-updated', bridge('updated'))
    expect(router.appRefreshRequired()).toBe(false)
    router.unregister('already-updated')
  })

  it('starts without upgrade pending when persisted versions match', () => {
    const router = createBridgeRouter({ lastRefreshedToolCatalogVersion: CHATGPT_WEB_TOOL_CATALOG_VERSION })
    expect(router.catalogStatus()).toEqual({ version: CHATGPT_WEB_TOOL_CATALOG_VERSION, appRefreshRequired: false })
    router.register('current-session', bridge('current'))
    expect(router.appRefreshRequired()).toBe(false)
    router.unregister('current-session')
  })

  it('keeps catalogs identical across registration and controller state', async () => {
    const router = createBridgeRouter()
    const names = (tools: Array<{ name: string }>) => tools.map((tool) => tool.name).sort()
    const listTools = async () =>
      names(
        (
          (await router.handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' })) as {
            result: { tools: Array<{ name: string }> }
          }
        ).result.tools
      )
    const reviewNames = ['start_review_loop', 'submit_review_fix', 'wait_review_fix', 'finish_review_loop']

    const before = await listTools()
    for (const name of reviewNames) expect(before).toContain(name)

    // Registration without a controller does not alter the catalog.
    router.register('without-loop', bridge('without-loop'))
    expect(await listTools()).toEqual(before)

    // Registration with a fake controller also preserves the catalog.
    router.register('with-loop', bridge('with-loop', { reviewLoop: fakeLoop() as never }))
    expect(await listTools()).toEqual(before)

    // Unregister restores the same set.
    router.unregister('without-loop')
    router.unregister('with-loop')
    expect(await listTools()).toEqual(before)
    expect(router.size()).toBe(0)
  })

  it('requires session_key even for review tools', async () => {
    const router = createBridgeRouter()
    const missing = await callRouter(router, 'start_review_loop', {})
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain('session_key is required')
  })

  it('rejects review calls without a controller', async () => {
    const router = createBridgeRouter()
    router.register('without-loop', bridge('without-loop'))
    const refused = await callRouter(router, 'submit_review_fix', {
      session_key: 'without-loop',
      loop_id: 'rl_test',
      iteration: 1,
      findings: [{ id: 'f1', severity: 'blocking', title: 't', details: 'd' }],
      idempotency_key: 'valid-key-102',
    })
    expect(refused.isError).toBe(true)
    expect(refused.content[0].text).toContain('review loop is unavailable')
  })

  it('routes review calls through the session controller', async () => {
    const router = createBridgeRouter()
    const loop = fakeLoop({
      submit: async () => ({ loopId: 'rl_test', jobId: 'j_1', iteration: 1, status: 'running', startedAt: 1 }),
    })
    router.register('with-loop', bridge('with-loop', { reviewLoop: loop as never }))
    const out = await callRouter(router, 'submit_review_fix', {
      session_key: 'with-loop',
      loop_id: 'rl_test',
      iteration: 1,
      findings: [{ id: 'f1', severity: 'blocking', title: 't', details: 'd' }],
      idempotency_key: 'valid-key-103',
    })
    expect(out.isError).not.toBe(true)
    expect(out.content[0].text).toContain('"jobId": "j_1"')
  })

  it('discovers and executes actions during app creation and update', async () => {
    // First, a router without sessions.
    const router = createBridgeRouter()
    // 2. initialize
    await router.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    })
    // ChatGPT discovers the static tools/list catalog.
    const list = (await router.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: {
        tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } }>
      }
    }
    for (const name of ['start_review_loop', 'submit_review_fix', 'wait_review_fix', 'finish_review_loop']) {
      const tool = list.result.tools.find((candidate) => candidate.name === name)
      expect(tool).toBeDefined()
      expect(tool?.inputSchema.properties).toHaveProperty('session_key')
      expect(tool?.inputSchema.required).toContain('session_key')
    }
    // Register a session with a controller.
    const loop = fakeLoop({
      start: async () => ({
        loopId: 'rl_abc',
        status: 'reviewing',
        iteration: 1,
        maxIterations: 2,
        severityThreshold: 'important',
        baseline: { branch: 'main', head: 'abc', workspaceFingerprint: 'fp' },
        executor: { providerId: 'builtin_codex', modelId: 'gpt-5.6' },
      }),
    })
    router.register('new-session', bridge('ctx', { reviewLoop: loop as never }))
    // 5. Execute an action with the matching session_key.
    const started = await callRouter(router, 'start_review_loop', {
      session_key: 'new-session',
      idempotency_key: 'valid-key-104',
      max_iterations: 2,
    })
    expect(started.isError).not.toBe(true)
    expect(started.content[0].text).toContain('rl_abc')
  })

  it('returns complete stateless envelopes after discovery', async () => {
    const router = createBridgeRouter()
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const list = (await router.handleMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: { _meta: meta },
    })) as { result: { resultType: string; ttlMs: number; cacheScope: string; tools: unknown[] } }
    expect(list.result).toMatchObject({ resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
    expect(list.result.tools.length).toBeGreaterThan(0)

    router.register('modern-session', bridge('modern-context'))
    const call = (await router.handleMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { _meta: meta, name: 'get_context', arguments: { session_key: 'modern-session' } },
    })) as { result: { resultType: string; content: Array<{ text: string }> } }
    expect(call.result.resultType).toBe('complete')
    expect(call.result.content[0].text).toContain('modern-context')
  })

  it('routes reads and deliveries through the correct session_key', async () => {
    const router = createBridgeRouter()
    const alphaDeliveries: BridgeDelivery[] = []
    const betaDeliveries: BridgeDelivery[] = []
    router.register(
      'aaa',
      bridge('alpha-context', {
        conversation: {
          getContext: () => ({ marker: 'alpha-conversation', latest_seq: 0, revision: 'revision-alpha' }),
          getRevision: () => 'revision-alpha',
          search: () => ({ hits: [] }),
          read: () => ({ messages: [] }),
        },
        deliver: (delivery) => {
          alphaDeliveries.push(delivery)
        },
      })
    )
    router.register(
      'bbb',
      bridge('beta-context', {
        conversation: {
          getContext: () => ({ marker: 'beta-conversation', latest_seq: 0, revision: 'revision-beta' }),
          getRevision: () => 'revision-beta',
          search: () => ({ hits: [] }),
          read: () => ({ messages: [] }),
        },
        deliver: (delivery) => {
          betaDeliveries.push(delivery)
        },
      })
    )

    expect((await callRouter(router, 'get_context', { session_key: 'aaa' })).content[0].text).toContain('alpha-context')
    expect((await callRouter(router, 'get_context', { session_key: 'bbb' })).content[0].text).toContain('beta-context')
    expect((await callRouter(router, 'get_conversation_context', { session_key: 'aaa' })).content[0].text).toContain(
      'alpha-conversation'
    )
    expect((await callRouter(router, 'get_conversation_context', { session_key: 'bbb' })).content[0].text).toContain(
      'beta-conversation'
    )
    await callRouter(router, 'glob', { session_key: 'bbb', pattern: 'src/**/*.ts' })
    await callRouter(router, 'read_file', { session_key: 'bbb', path: 'package.json' })

    await callRouter(router, 'send_to_maestrly', {
      session_key: 'bbb',
      destination: 'chat',
      markdown: 'Only beta',
      idempotency_key: 'beta-delivery-001',
      confidence: 'high',
      uninspected_areas: [],
      assumptions: [],
    })
    expect(alphaDeliveries).toEqual([])
    expect(betaDeliveries).toHaveLength(1)
    expect(betaDeliveries[0].markdown).toContain('Only beta')
    expect(betaDeliveries[0].markdown).toContain('## Investigation coverage')
  })

  it('rejects missing, unknown and revoked keys', async () => {
    const router = createBridgeRouter()
    router.register('ativa', bridge('ok'))

    const missing = await callRouter(router, 'get_context', {})
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toContain('session_key is required')

    const unknown = await callRouter(router, 'get_context', { session_key: 'other' })
    expect(unknown.isError).toBe(true)
    expect(unknown.content[0].text).toContain('no longer active')

    const foreignConversation = await callRouter(router, 'get_conversation_context', { session_key: 'other' })
    expect(foreignConversation.isError).toBe(true)
    expect(foreignConversation.content[0].text).toContain('no longer active')

    router.unregister('ativa')
    const revoked = await callRouter(router, 'get_context', { session_key: 'ativa' })
    expect(revoked.isError).toBe(true)
    expect(revoked.content[0].text).toContain('no longer active')
    const revokedConversation = await callRouter(router, 'get_conversation_context', { session_key: 'ativa' })
    expect(revokedConversation.isError).toBe(true)
  })

  it('keeps session_key out of executors and events', async () => {
    const events: Array<Record<string, unknown>> = []
    const target = createChatGptWebBridge({
      cwd: process.cwd(),
      runGit: async () => 'ok',
      onEvent: (event) => events.push(event as unknown as Record<string, unknown>),
    })
    const router = createBridgeRouter()
    router.register('secret-key', target)
    await callRouter(router, 'get_context', { session_key: 'secret-key' })
    const event = events.find((candidate) => candidate.kind === 'tool-call') as
      | { args?: Record<string, unknown> }
      | undefined
    expect(event?.args).not.toHaveProperty('session_key')
    expect(JSON.stringify(events)).not.toContain('secret-key')
  })

  it('aborts pending calls on revocation without stale results', async () => {
    let release!: () => void
    let started = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const target = bridge('stale context', {
      projectContext: async () => {
        started = true
        await gate
        return 'stale context'
      },
    })
    const router = createBridgeRouter()
    router.register('revogar', target)
    const running = callRouter(router, 'get_context', { session_key: 'revogar' })
    await vi.waitFor(() => expect(started).toBe(true))
    expect(router.unregister('revogar')).toBe(true)
    const result = await running
    release()
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('companion session ended')
    expect(result.content[0].text).not.toContain('stale context')
  })

  it('rearms keys in new bridges without reviving ended instances', async () => {
    const router = createBridgeRouter()
    const original = bridge('old-context')
    router.register('stable-key', original)
    expect(router.unregister('stable-key')).toBe(true)

    const whileDisabled = await callRouter(router, 'get_context', { session_key: 'stable-key' })
    expect(whileDisabled.isError).toBe(true)
    expect(whileDisabled.content[0].text).toContain('no longer active')

    router.register('stable-key', bridge('resumed-context'))
    const resumed = await callRouter(router, 'get_context', { session_key: 'stable-key' })
    expect(resumed.isError).not.toBe(true)
    expect(resumed.content[0].text).toContain('resumed-context')

    const stale = (await original.callTool('get_context', {})) as ToolResult
    expect(stale.isError).toBe(true)
    expect(stale.content[0].text).toContain('companion session ended')
  })
})

describe('tools companion auxiliares', () => {
  it('get_context advertises checks, skills, and project context', async () => {
    const target = bridge('git', {
      projectContext: () => 'project rule',
      listSkills: () => [{ name: 'review', description: 'Review changes' }],
      readSkill: (name) => (name === 'review' ? '# Skill review' : null),
      listChecks: () => [{ name: 'test', description: 'Tests' }],
    })
    const context = (await target.callTool('get_context', {})).content[0].text
    expect(context).toContain('project rule')
    expect(context).toContain('`review`')
    expect(context).toContain('`test`')
    expect((await target.callTool('read_skill', { name: 'review' })).content[0].text).toContain('# Skill review')
  })

  it('accepts only allowlisted check names', async () => {
    const runCheck = vi.fn(async () => ({ exitCode: 0, output: 'ok' }))
    const target = bridge('git', {
      listChecks: () => [{ name: 'test', description: 'Tests' }],
      runCheck,
    })
    expect((await target.callTool('run_check', { name: 'test' })).content[0].text).toContain('exit code 0')
    expect(((await target.callTool('run_check', { name: 'test; rm -rf .' })) as ToolResult).isError).toBe(true)
    expect(runCheck).toHaveBeenCalledTimes(1)
  })
})
