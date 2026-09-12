import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createChatGptWebBridge,
  type BridgeDelivery,
  type BridgeEvent,
  type BridgeToolResult,
} from '../../src/main/chat/chatgpt-web/bridge-server'
import {
  buildCompanionPrompt,
  createChatGptWebSession,
  deriveResumableSessionKey,
} from '../../src/main/chat/chatgpt-web/session'
import { createRepositoryScope } from '../../src/main/repository-scope'
import type { Conversation } from '../../src/main/store/conversations'
import { createPlanReviewController } from '../../src/main/chat/chatgpt-web/plan-review'

let repo: string

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'chatweb-bridge-'))
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(
    path.join(repo, 'package.json'),
    '{\n  "name": "fixture",\n  "scripts": { "test": "vitest" },\n  "dependencies": { "react": "latest" },\n  "devDependencies": { "vite": "latest", "vitest": "latest" }\n}\n'
  )
  writeFileSync(path.join(repo, 'src', 'alpha.ts'), 'export const alpha = 1\n// TODO: review\n')
  writeFileSync(path.join(repo, 'src', 'beta.txt'), 'beta\n')
})

describe('attachable bridge browser and skill bootstrap', () => {
  it('lists and attaches through capability gates outside review loops', async () => {
    const browser = {
      info: vi.fn(() => ({ state: 'ready', url: 'http://localhost:5173/' })),
      snapshot: vi.fn(async () => ({ url: 'http://localhost:5173/', elements: [] })),
      dispose: vi.fn(async () => undefined),
    }
    let active: typeof browser | null = null
    const browserSession = {
      list: vi.fn(() => [{ id: 'browser_opaque', title: 'Game', url: 'http://localhost:5173/', active: true }]),
      attach: vi.fn(async () => (active = browser)),
      detach: vi.fn(async () => {
        active = null
      }),
      active: vi.fn(() => active),
      attachedId: vi.fn(() => (active ? 'browser_opaque' : null)),
      dispose: vi.fn(async () => undefined),
    }
    const off = makeBridge({ browserCapability: 'off', browserSession: browserSession as never }).bridge
    expect((await call(off, 'browser_list_tabs')).result.isError).toBe(true)

    const inspect = makeBridge({ browserCapability: 'inspect', browserSession: browserSession as never }).bridge
    expect(await textOf(call(inspect, 'browser_list_tabs'))).toContain('browser_opaque')
    expect(await textOf(call(inspect, 'browser_attach', { browser_id: 'browser_opaque' }))).toContain('ready')
    expect(await textOf(call(inspect, 'browser_snapshot'))).toContain('localhost:5173')
    await call(inspect, 'browser_detach')
    expect(browserSession.detach).toHaveBeenCalledOnce()
    expect((await call(inspect, 'browser_snapshot')).result.isError).toBe(true)
  })

  it('resolves enabled skills without forwarding remote commands', async () => {
    const start = vi.fn(async () => ({
      jobId: 'pej_1',
      status: 'running' as const,
      startedAt: 1,
      skillName: 'dev-iso',
      executor: { providerId: 'codex', modelId: 'gpt' },
    }))
    const wait = vi.fn(async () => ({
      jobId: 'pej_1',
      status: 'completed' as const,
      startedAt: 1,
      finishedAt: 2,
      skillName: 'dev-iso',
    }))
    const cancel = vi.fn(() => ({
      jobId: 'pej_1',
      status: 'cancelled' as const,
      startedAt: 1,
      finishedAt: 2,
      skillName: 'dev-iso',
    }))
    const controller = { start, wait, cancel, stop: vi.fn(), info: vi.fn(), getJob: vi.fn() }
    const bridge = makeBridge({
      browserCapability: 'interact',
      listSkills: () => [{ name: 'dev-iso', description: 'Sobe o jogo' }],
      readSkill: (name) => (name === 'dev-iso' ? 'make dev-iso' : null),
      projectEnvironment: controller as never,
    }).bridge

    expect(
      (
        await call(bridge, 'start_project_environment', {
          skill: 'missing',
          idempotency_key: 'bootstrap-missing-001',
        })
      ).result.isError
    ).toBe(true)
    expect(
      await textOf(
        call(bridge, 'start_project_environment', {
          skill: 'dev-iso',
          idempotency_key: 'bootstrap-dev-iso-001',
        })
      )
    ).toContain('pej_1')
    expect(start).toHaveBeenCalledWith({
      skillName: 'dev-iso',
      skillBody: 'make dev-iso',
      idempotencyKey: 'bootstrap-dev-iso-001',
    })
    expect(await textOf(call(bridge, 'wait_project_environment', { job_id: 'pej_1', wait_seconds: 1 }))).toContain(
      'completed'
    )
    expect(await textOf(call(bridge, 'cancel_project_environment', { job_id: 'pej_1' }))).toContain('cancelled')
    bridge.endSession()
    expect(controller.stop).toHaveBeenCalledOnce()
  })
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

function makeBridge(overrides: Partial<Parameters<typeof createChatGptWebBridge>[0]> = {}) {
  const events: BridgeEvent[] = []
  const bridge = createChatGptWebBridge({
    cwd: repo,
    onEvent: (event) => events.push(event),
    runGit: async () => 'fake-git-output',
    planReview: createPlanReviewController(),
    ...overrides,
  })
  return { bridge, events }
}

const call = (bridge: ReturnType<typeof createChatGptWebBridge>, name: string, args: Record<string, unknown> = {}) =>
  bridge.handleMessage({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e6),
    method: 'tools/call',
    params: { name, arguments: args },
  }) as Promise<{ result: { content: Array<{ text: string }>; isError?: boolean } }>

const textOf = async (promise: ReturnType<typeof call>) => (await promise).result.content[0].text

const disclosure = {
  confidence: 'medium',
  uninspected_areas: ['Unrelated external integrations'],
  assumptions: ['Existing tests represent the expected contract'],
}

async function investigate(bridge: ReturnType<typeof createChatGptWebBridge>) {
  await call(bridge, 'get_context')
  await call(bridge, 'glob', { pattern: 'src/**/*.ts' })
  await call(bridge, 'read_file', { path: 'src/alpha.ts' })
}

describe('bridge MCP companion — protocolo', () => {
  it('supports server/discover in isolated session handlers', async () => {
    const { bridge } = makeBridge()
    const response = (await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 'openai-mcp-discover',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    })) as {
      result: {
        resultType: string
        supportedVersions: string[]
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: string } }
      }
    }
    expect(response.result.resultType).toBe('complete')
    expect(response.result.supportedVersions).toContain('2026-07-28')
    expect(response.result._meta['io.modelcontextprotocol/serverInfo'].name).toBe('maestrly-bridge')
  })

  it('exposes the complete companion catalog and requires session_key throughout', async () => {
    const { bridge } = makeBridge()
    const init = (await bridge.handleMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test' } },
    })) as { result: { protocolVersion: string; instructions: string } }
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.instructions).toContain('send_to_maestrly')
    expect(init.result.instructions).toContain('wait_plan_review')
    expect(init.result.instructions).toContain('Converse normally')
    expect(init.result.instructions).toContain('search-* and api-get are global')
    expect(init.result.instructions).toContain('cancelled requires actual user cancellation')
    expect(init.result.instructions).not.toContain('next_input')

    const list = (await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: {
        tools: Array<{
          name: string
          description?: string
          annotations?: { readOnlyHint?: boolean }
          inputSchema: {
            properties?: Record<
              string,
              {
                description?: string
                minLength?: number
                maxLength?: number
                pattern?: string
                minItems?: number
                items?: unknown
              }
            >
            required?: string[]
          }
        }>
      }
    }
    // The catalog remains complete even without a review controller;
    // tools/call validates availability instead of hiding schemas.
    expect(list.result.tools.map((tool) => tool.name)).toEqual([
      'discover_frontend_previews',
      'browser_list_tabs',
      'browser_attach',
      'browser_detach',
      'browser_snapshot',
      'browser_screenshot',
      'browser_read_text',
      'browser_wait_for',
      'browser_console_logs',
      'browser_network_logs',
      'browser_navigate',
      'browser_reload',
      'browser_scroll',
      'browser_click',
      'browser_double_click',
      'browser_type',
      'browser_press_key',
      'browser_drag',
      'list_external_capabilities',
      'search_mcp_tools',
      'call_mcp_read_tool',
      'call_mcp_write_tool',
      'git_read',
      'gh_read',
      'get_context',
      'search_project_memory',
      'read_project_memory_source',
      'get_conversation_context',
      'search_conversation',
      'read_conversation',
      'read_file',
      'grep',
      'glob',
      'git_diff',
      'run_check',
      'read_skill',
      'start_project_environment',
      'wait_project_environment',
      'cancel_project_environment',
      'notify_turn_complete',
      'send_to_maestrly',
      'wait_plan_review',
      'start_review_loop',
      'submit_review_fix',
      'wait_review_fix',
      'finish_review_loop',
    ])
    expect(
      list.result.tools.every(
        (tool) =>
          'session_key' in (tool.inputSchema.properties ?? {}) && tool.inputSchema.required?.includes('session_key')
      )
    ).toBe(true)
    expect(list.result.tools.find((tool) => tool.name === 'read_file')?.annotations?.readOnlyHint).toBe(true)
    expect(list.result.tools.find((tool) => tool.name === 'browser_screenshot')?.annotations?.readOnlyHint).toBe(true)
    expect(list.result.tools.find((tool) => tool.name === 'browser_click')?.annotations?.readOnlyHint).toBe(false)
    expect(list.result.tools.some((tool) => tool.name === 'browser_evaluate')).toBe(false)
    expect(list.result.tools.find((tool) => tool.name === 'call_mcp_read_tool')?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    })
    expect(list.result.tools.find((tool) => tool.name === 'call_mcp_write_tool')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
    })
    const capabilitiesTool = list.result.tools.find((tool) => tool.name === 'list_external_capabilities')
    const searchMcpTool = list.result.tools.find((tool) => tool.name === 'search_mcp_tools')
    const callMcpTool = list.result.tools.find((tool) => tool.name === 'call_mcp_read_tool')
    const gitTool = list.result.tools.find((tool) => tool.name === 'git_read')
    const ghTool = list.result.tools.find((tool) => tool.name === 'gh_read')
    const conversationContextTool = list.result.tools.find((tool) => tool.name === 'get_conversation_context')
    const searchConversationTool = list.result.tools.find((tool) => tool.name === 'search_conversation')
    const readConversationTool = list.result.tools.find((tool) => tool.name === 'read_conversation')
    const readFileTool = list.result.tools.find((tool) => tool.name === 'read_file')
    const grepTool = list.result.tools.find((tool) => tool.name === 'grep')
    const gitDiffTool = list.result.tools.find((tool) => tool.name === 'git_diff')
    const runCheckTool = list.result.tools.find((tool) => tool.name === 'run_check')
    const notifyTool = list.result.tools.find((tool) => tool.name === 'notify_turn_complete')
    const waitPlanTool = list.result.tools.find((tool) => tool.name === 'wait_plan_review')
    const submitTool = list.result.tools.find((tool) => tool.name === 'submit_review_fix')
    expect(capabilitiesTool?.description).toContain('repositories[].id')
    expect(capabilitiesTool?.description).toContain('global search-* and API GET')
    expect(searchMcpTool?.inputSchema.properties?.server_id?.description).toContain('Exact serverId')
    expect(searchMcpTool?.inputSchema.properties?.query?.maxLength).toBe(200)
    expect(callMcpTool?.inputSchema.properties?.tool_name?.description).toContain('Exact toolName')
    expect(gitTool?.description).toContain('does not replace git_diff')
    expect(ghTool?.description).toContain('never owner/repo')
    expect(ghTool?.description).toContain('GLOBAL')
    expect(ghTool?.inputSchema.properties?.repo?.description).toContain('not owner/repo')
    expect(ghTool?.inputSchema.properties?.repo?.description).toContain('optional for global operations')
    expect(conversationContextTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
    expect(searchConversationTool?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
    expect(searchConversationTool?.inputSchema.properties?.query?.maxLength).toBe(200)
    expect(searchConversationTool?.inputSchema.properties?.limit).toMatchObject({ maximum: 20 })
    expect(readConversationTool?.inputSchema.properties?.around_seq).toMatchObject({ minimum: 0 })
    expect(readConversationTool?.inputSchema.properties?.limit).toMatchObject({ maximum: 20 })
    expect(readFileTool?.inputSchema.properties?.path?.description).toContain('<repo-id>/')
    expect(grepTool?.inputSchema.properties?.path?.description).toContain('<repo-id>/')
    expect(gitDiffTool?.inputSchema.properties?.repo?.description).toContain('repositories[].id')
    expect(runCheckTool?.description).toContain('may create files')
    expect(runCheckTool?.description).not.toContain('nothing is written')
    expect(notifyTool?.inputSchema.properties?.idempotency_key).toMatchObject({
      minLength: 8,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._:-]{8,128}$',
    })
    expect(waitPlanTool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(waitPlanTool?.inputSchema.required).toContain('plan_review_id')
    expect(submitTool?.inputSchema.properties?.findings?.minItems).toBe(1)
    expect(list.result.tools.find((tool) => tool.name === 'send_to_maestrly')?.annotations).toBeUndefined()
    expect(list.result.tools.find((tool) => tool.name === 'run_check')?.inputSchema.required).not.toContain(
      'instruction_id'
    )
    expect(list.result.tools.find((tool) => tool.name === 'send_to_maestrly')?.inputSchema.required).toEqual(
      expect.arrayContaining(['confidence', 'uninspected_areas', 'assumptions'])
    )
    const unavailable = (await bridge.callTool('list_external_capabilities', {})) as BridgeToolResult
    expect(unavailable.isError).toBe(true)
    expect(unavailable.content[0].text).toContain('external-capabilities-unavailable')
  })

  it('gates the read-only memory adapter, validates inputs and never logs search text', async () => {
    const off = makeBridge().bridge
    expect((await call(off, 'search_project_memory', { query: 'release' })).result).toMatchObject({ isError: true })
    expect((await call(off, 'read_project_memory_source', { kind: 'local', id: 'memory-1' })).result).toMatchObject({
      isError: true,
    })

    const status = vi.fn(() => ({ enabled: true, state: 'text-only', documents: 2 }))
    const search = vi.fn(() => ({ hits: [{ kind: 'shared', id: 'release', snippet: 'bounded result' }] }))
    const read = vi.fn(() => ({ kind: 'local', id: 'memory-1', content: 'bounded source' }))
    const { bridge, events } = makeBridge({ memory: { status, search, read } })
    const secretQuery = 'private release investigation details'

    expect(await textOf(call(bridge, 'get_context'))).toContain('"state": "text-only"')
    expect(
      await textOf(call(bridge, 'search_project_memory', { query: secretQuery, limit: 3, repo: 'backend' }))
    ).toContain('bounded result')
    expect(search).toHaveBeenCalledWith({ query: secretQuery, limit: 3, repo: 'backend' }, expect.any(AbortSignal))
    expect(
      await textOf(
        call(bridge, 'read_project_memory_source', {
          kind: 'shared',
          id: 'release',
          repo: 'backend',
          path: '.agents/knowledge/decision/release.md',
        })
      )
    ).toContain('bounded source')
    expect(read).toHaveBeenCalledWith(
      {
        kind: 'shared',
        id: 'release',
        repo: 'backend',
        path: '.agents/knowledge/decision/release.md',
      },
      expect.any(AbortSignal)
    )

    expect((await call(bridge, 'search_project_memory', { query: '   ' })).result.isError).toBe(true)
    expect((await call(bridge, 'search_project_memory', { query: 'ok', limit: 11 })).result.isError).toBe(true)
    expect((await call(bridge, 'read_project_memory_source', { kind: 'other', id: 'x' })).result.isError).toBe(true)
    expect(search).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)

    const searchEvent = events.find((event) => event.kind === 'tool-call' && event.name === 'search_project_memory')
    expect(searchEvent).toMatchObject({ args: { limit: 3, repo: 'backend' }, ok: true })
    expect(JSON.stringify(events)).not.toContain(secretQuery)
  })

  it('authorizes conversation access through adapters and requires a brief for Read reviews', async () => {
    const off = makeBridge({ reviewLoop: makeFakeLoop() as never }).bridge
    for (const name of ['get_conversation_context', 'search_conversation', 'read_conversation']) {
      const result = await call(
        off,
        name,
        name === 'search_conversation' ? { query: 'decision' } : name === 'read_conversation' ? { around_seq: 1 } : {}
      )
      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain('Conversation access is Off')
    }
    expect(
      (await call(off, 'start_review_loop', { idempotency_key: 'conversation-off-review-001' })).result.isError
    ).not.toBe(true)

    const loop = makeFakeLoop()
    const conversation = {
      getContext: vi.fn(() => ({ latest_seq: 7, revision: 'revision-7', messages: [] })),
      getRevision: vi.fn(() => 'revision-7'),
      search: vi.fn(() => ({ hits: [{ seq: 3, snippet: 'decision' }] })),
      read: vi.fn(() => ({ found: true, messages: [{ seq: 3, content: 'decision' }] })),
    }
    const { bridge: read, events } = makeBridge({ reviewLoop: loop as never, conversation })
    const before = await call(read, 'start_review_loop', { idempotency_key: 'conversation-read-review-001' })
    expect(before.result.isError).toBe(true)
    expect(before.result.content[0].text).toContain('get_conversation_context')
    read.setReviewIteration('rl_requirements', 1)
    await call(read, 'search_conversation', { query: 'decision', limit: 10 })
    await call(read, 'read_conversation', { around_seq: 3, limit: 10 })
    expect(read.getReviewEvidence('rl_requirements').byIteration[1]).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain('decision')
    read.clearReviewIteration('rl_requirements')
    const stillBlocked = await call(read, 'start_review_loop', {
      idempotency_key: 'conversation-read-review-002',
    })
    expect(stillBlocked.result.isError).toBe(true)
    expect(loop.start).not.toHaveBeenCalled()
    expect((await call(read, 'get_conversation_context')).result.isError).not.toBe(true)
    expect(
      (await call(read, 'start_review_loop', { idempotency_key: 'conversation-read-review-003' })).result.isError
    ).not.toBe(true)
    expect(loop.start).toHaveBeenCalledOnce()
  })

  it('consumes brief authorization at loop start and requires fresh reads for the next loop', async () => {
    const loop = makeFakeLoop()
    const conversation = {
      getContext: vi.fn(() => ({ latest_seq: 7, revision: 'revision-7', messages: [] })),
      getRevision: vi.fn(() => 'revision-7'),
      search: vi.fn(() => ({ hits: [] })),
      read: vi.fn(() => ({ found: false, messages: [] })),
    }
    const { bridge } = makeBridge({ reviewLoop: loop as never, conversation })

    await call(bridge, 'get_conversation_context')
    expect(
      (await call(bridge, 'start_review_loop', { idempotency_key: 'conversation-sequential-001' })).result.isError
    ).not.toBe(true)

    const blockedBeforeFinish = await call(bridge, 'start_review_loop', {
      idempotency_key: 'conversation-sequential-002',
    })
    expect(blockedBeforeFinish.result.isError).toBe(true)
    expect(blockedBeforeFinish.result.content[0].text).toContain('get_conversation_context')
    // Retry of the successful start remains admitted without reloading the brief.
    expect(
      (await call(bridge, 'start_review_loop', { idempotency_key: 'conversation-sequential-001' })).result.isError
    ).not.toBe(true)

    const finishArgs = {
      loop_id: 'rl_test',
      result: 'clean',
      summary: 'Loop complete.',
      idempotency_key: 'conversation-sequential-finish-001',
    }
    expect((await call(bridge, 'finish_review_loop', finishArgs)).result.isError).not.toBe(true)
    // Idempotent finish retries do not require new briefs.
    expect((await call(bridge, 'finish_review_loop', finishArgs)).result.isError).not.toBe(true)

    const blocked = await call(bridge, 'start_review_loop', { idempotency_key: 'conversation-sequential-003' })
    expect(blocked.result.isError).toBe(true)
    expect(blocked.result.content[0].text).toContain('get_conversation_context')
    expect(loop.start).toHaveBeenCalledTimes(2)

    await call(bridge, 'get_conversation_context')
    expect(
      (await call(bridge, 'start_review_loop', { idempotency_key: 'conversation-sequential-004' })).result.isError
    ).not.toBe(true)
    expect(conversation.getContext).toHaveBeenCalledTimes(2)
    expect(loop.start).toHaveBeenCalledTimes(3)
  })

  it('rejects stale briefs until the current revision is reloaded', async () => {
    const loop = makeFakeLoop()
    let revision = 'revision-7'
    const streamingMessage = { seq: 7, message_id: 'assistant-streaming', content: 'partial response' }
    const conversation = {
      getContext: vi.fn(() => ({ latest_seq: 7, revision, messages: [streamingMessage] })),
      getRevision: vi.fn(() => revision),
      search: vi.fn(() => ({ hits: [] })),
      read: vi.fn(() => ({ found: false, messages: [] })),
    }
    const { bridge } = makeBridge({ reviewLoop: loop as never, conversation })

    await call(bridge, 'get_conversation_context')
    // Streaming changes the safe projection without changing row sequence or message ID.
    streamingMessage.content = 'completed response'
    revision = 'revision-8'
    const stale = await call(bridge, 'start_review_loop', { idempotency_key: 'conversation-stale-001' })
    expect(stale.result.isError).toBe(true)
    expect(stale.result.content[0].text).toContain('stale')
    expect(stale.result.content[0].text).toContain('get_conversation_context')
    expect(loop.start).not.toHaveBeenCalled()

    await call(bridge, 'get_conversation_context')
    expect(
      (await call(bridge, 'start_review_loop', { idempotency_key: 'conversation-stale-002' })).result.isError
    ).not.toBe(true)
    expect(conversation.getContext).toHaveBeenCalledTimes(2)
    expect(conversation.getRevision).toHaveBeenCalledTimes(2)
    expect(loop.start).toHaveBeenCalledOnce()
  })

  it('records explicit completions and deduplicates per session without delivery', async () => {
    const { bridge, events } = makeBridge()
    const list = (await bridge.handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' })) as {
      result: {
        tools: Array<{
          name: string
          annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean }
          inputSchema: { properties?: Record<string, unknown>; required?: string[] }
        }>
      }
    }
    const tool = list.result.tools.find((candidate) => candidate.name === 'notify_turn_complete')
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true })
    expect(tool?.inputSchema.required).toContain('idempotency_key')

    expect((await call(bridge, 'notify_turn_complete', { idempotency_key: '' })).result.isError).toBe(true)
    expect((await call(bridge, 'notify_turn_complete', { idempotency_key: 'completion-001' })).result.isError).not.toBe(
      true
    )
    expect((await call(bridge, 'notify_turn_complete', { idempotency_key: 'completion-001' })).result.isError).not.toBe(
      true
    )
    expect((await call(bridge, 'notify_turn_complete', { idempotency_key: 'completion-002' })).result.isError).not.toBe(
      true
    )

    expect(events.filter((event) => event.kind === 'turn-completed')).toEqual([
      { kind: 'turn-completed', idempotencyKey: 'completion-001', deduplicated: false },
      { kind: 'turn-completed', idempotencyKey: 'completion-001', deduplicated: true },
      { kind: 'turn-completed', idempotencyKey: 'completion-002', deduplicated: false },
    ])
    expect(bridge.stats().completedTurns).toBe(2)
    expect(bridge.stats().deliveries).toBe(0)

    bridge.endSession()
    expect((await call(bridge, 'notify_turn_complete', { idempotency_key: 'completion-late' })).result.isError).toBe(
      true
    )
    expect(events.filter((event) => event.kind === 'turn-completed')).toHaveLength(3)
  })

  it('ignores notifications and rejects unknown methods', async () => {
    const { bridge } = makeBridge()
    expect(await bridge.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
    const bad = (await bridge.handleMessage({ jsonrpc: '2.0', id: 9, method: 'nope' })) as {
      error: { code: number }
    }
    expect(bad.error.code).toBe(-32601)
  })
})

describe('send_to_maestrly', () => {
  it('delivers chat and plans through explicit contracts', async () => {
    const delivered: BridgeDelivery[] = []
    const { bridge } = makeBridge({
      deliver: (delivery) => {
        delivered.push(delivery)
      },
    })
    await investigate(bridge)
    expect(
      await textOf(
        call(bridge, 'send_to_maestrly', {
          destination: 'chat',
          markdown: '# Summary',
          title: 'Resultado',
          idempotency_key: 'delivery-chat-001',
          ...disclosure,
        })
      )
    ).toContain('originating conversation')
    expect(
      await textOf(
        call(bridge, 'send_to_maestrly', {
          destination: 'plan',
          markdown: '# Plan',
          idempotency_key: 'delivery-plan-001',
          ...disclosure,
        })
      )
    ).toContain('Plan tab')
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toMatchObject({
      destination: 'chat',
      title: 'Resultado',
      idempotencyKey: 'delivery-chat-001',
    })
    expect(delivered[0].markdown).toContain('# Summary')
    expect(delivered[0].markdown).toContain('## Investigation coverage')
    expect(delivered[0].markdown).toContain('`src/alpha.ts`')
    expect(delivered[0].markdown).toContain('`glob src/**/*.ts`')
    expect(delivered[0].markdown).toContain('Unrelated external integrations')
    expect(delivered[0].markdown).toContain('Confidence reported by the model: **medium**')
    expect(delivered[1]).toMatchObject({
      destination: 'plan',
      idempotencyKey: 'delivery-plan-001',
      planReviewId: expect.stringMatching(/^pr_[a-f0-9]{32}$/),
    })
    expect(delivered[1].markdown).toContain('# Plan')
    expect(bridge.stats().deliveries).toBe(2)
  })

  it('deduplicates retries and rejects key reuse with different content', async () => {
    const deliver = vi.fn()
    const { bridge, events } = makeBridge({ deliver })
    await investigate(bridge)
    const args = {
      destination: 'chat',
      markdown: 'Same content',
      idempotency_key: 'stable-retry-key',
      ...disclosure,
    }
    await call(bridge, 'send_to_maestrly', args)
    expect(await textOf(call(bridge, 'send_to_maestrly', args))).toContain('duplicate')
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(bridge.stats().deliveries).toBe(1)
    expect(events.some((event) => event.kind === 'delivery' && event.deduplicated)).toBe(true)

    const conflict = await call(bridge, 'send_to_maestrly', { ...args, markdown: 'Different content' })
    expect(conflict.result.isError).toBe(true)
    expect(conflict.result.content[0].text).toContain('different content')
  })

  it('returns recoverable broker origin errors from send_to_maestrly', async () => {
    const deliver = vi.fn(() => {
      throw new Error('plan-origin-conflict')
    })
    const { bridge } = makeBridge({ deliver })
    await investigate(bridge)

    const response = await call(bridge, 'send_to_maestrly', {
      destination: 'plan',
      markdown: '# Conflicting plan',
      idempotency_key: 'plan-origin-conflict',
      ...disclosure,
    })

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('plan-origin-conflict')
    expect(deliver).toHaveBeenCalledOnce()
  })

  it('keeps plan IDs stable on retry and distinct across versions', async () => {
    const deliver = vi.fn()
    const { bridge } = makeBridge({ deliver })
    await investigate(bridge)
    const firstArgs = {
      destination: 'plan',
      markdown: '# v1',
      idempotency_key: 'plan-version-one',
      ...disclosure,
    }
    const first = await textOf(call(bridge, 'send_to_maestrly', firstArgs))
    const retry = await textOf(call(bridge, 'send_to_maestrly', firstArgs))
    const second = await textOf(
      call(bridge, 'send_to_maestrly', {
        ...firstArgs,
        markdown: '# v2',
        idempotency_key: 'plan-version-two',
      })
    )
    const id = (value: string) => value.match(/plan_review_id: (pr_[a-f0-9]{32})/)?.[1]

    expect(id(first)).toBeTruthy()
    expect(id(retry)).toBe(id(first))
    expect(id(second)).not.toBe(id(first))
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it('reuses manager-owned IDs after rearm without redelivering plans', async () => {
    const controller = createPlanReviewController()
    const firstDeliver = vi.fn()
    const secondDeliver = vi.fn()
    const first = makeBridge({ planReview: controller, deliver: firstDeliver }).bridge
    await investigate(first)
    const args = {
      destination: 'plan',
      markdown: '# Resumable plan',
      idempotency_key: 'plan-resume-stable',
      ...disclosure,
    }
    const firstText = await textOf(call(first, 'send_to_maestrly', args))
    first.endSession()

    const resumed = makeBridge({ planReview: controller, deliver: secondDeliver }).bridge
    await investigate(resumed)
    const resumedText = await textOf(call(resumed, 'send_to_maestrly', args))

    expect(firstText.match(/pr_[a-f0-9]{32}/)?.[0]).toBe(resumedText.match(/pr_[a-f0-9]{32}/)?.[0])
    expect(firstDeliver).toHaveBeenCalledOnce()
    expect(secondDeliver).not.toHaveBeenCalled()
  })

  it('deduplicates delivery completed at shutdown across rearm', async () => {
    const controller = createPlanReviewController()
    let firstBridge!: ReturnType<typeof createChatGptWebBridge>
    const firstDeliver = vi.fn(() => firstBridge.endSession())
    firstBridge = makeBridge({ planReview: controller, deliver: firstDeliver }).bridge
    await investigate(firstBridge)
    const args = {
      destination: 'plan',
      markdown: '# Boundary plan',
      idempotency_key: 'plan-lifecycle-edge',
      ...disclosure,
    }
    expect(await textOf(call(firstBridge, 'send_to_maestrly', args))).toContain('companion session ended')

    const resumedDeliver = vi.fn()
    const resumed = makeBridge({ planReview: controller, deliver: resumedDeliver }).bridge
    await investigate(resumed)
    expect(await textOf(call(resumed, 'send_to_maestrly', args))).toContain('plan_review_id')
    expect(firstDeliver).toHaveBeenCalledOnce()
    expect(resumedDeliver).not.toHaveBeenCalled()
  })

  it('validates destination, content and idempotency keys', async () => {
    const { bridge } = makeBridge({ deliver: vi.fn() })
    for (const args of [
      { destination: 'email', markdown: 'x', idempotency_key: 'valid-key-1' },
      { destination: 'chat', markdown: '', idempotency_key: 'valid-key-2' },
      { destination: 'chat', markdown: 'x', idempotency_key: 'curta' },
    ]) {
      expect((await call(bridge, 'send_to_maestrly', args)).result.isError).toBe(true)
    }
  })

  it('requires context, search and actual reads before publication', async () => {
    const deliver = vi.fn()
    const { bridge } = makeBridge({ deliver })
    const args = {
      destination: 'chat',
      markdown: 'Analysis',
      idempotency_key: 'coverage-gate-001',
      ...disclosure,
    }

    expect((await call(bridge, 'send_to_maestrly', args)).result.content[0].text).toContain('get_context')
    await call(bridge, 'get_context')
    expect((await call(bridge, 'send_to_maestrly', args)).result.content[0].text).toContain('grep or glob')
    await call(bridge, 'glob', { pattern: 'src/**/*.ts' })
    await call(bridge, 'git_diff')
    expect((await call(bridge, 'send_to_maestrly', args)).result.content[0].text).toContain('read at least')
    await call(bridge, 'read_file', { path: 'src/missing.ts' })
    expect((await call(bridge, 'send_to_maestrly', args)).result.content[0].text).toContain('read at least')
    await call(bridge, 'read_file', { path: 'src/alpha.ts' })
    expect((await call(bridge, 'send_to_maestrly', args)).result.isError).not.toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('requires explicit confidence, gaps and assumptions', async () => {
    const { bridge } = makeBridge({ deliver: vi.fn() })
    await investigate(bridge)
    const base = {
      destination: 'chat',
      markdown: 'Analysis',
      idempotency_key: 'coverage-fields-001',
    }
    expect((await call(bridge, 'send_to_maestrly', base)).result.content[0].text).toContain('confidence')
    expect((await call(bridge, 'send_to_maestrly', { ...base, confidence: 'high' })).result.content[0].text).toContain(
      'uninspected_areas'
    )
    expect(
      (
        await call(bridge, 'send_to_maestrly', {
          ...base,
          confidence: 'high',
          uninspected_areas: [],
        })
      ).result.content[0].text
    ).toContain('assumptions')
  })
})

describe('wait_plan_review', () => {
  it('returns waiting followed by revision feedback', async () => {
    const wait = vi
      .fn()
      .mockResolvedValueOnce({ status: 'waiting' })
      .mockResolvedValueOnce({ status: 'revise', feedbackText: 'add tests' })
    const { bridge } = makeBridge({
      planReview: {
        create: vi.fn(() => 'pr_fake'),
        isDelivered: vi.fn(() => false),
        markDelivered: vi.fn(() => ({ ok: true })),
        wait,
      },
    })

    expect(await textOf(call(bridge, 'wait_plan_review', { plan_review_id: 'pr_fake', wait_seconds: 1 }))).toContain(
      '"status":"waiting"'
    )
    const revised = await textOf(call(bridge, 'wait_plan_review', { plan_review_id: 'pr_fake', wait_seconds: 1 }))
    expect(revised).toContain('"status":"revise"')
    expect(revised).toContain('add tests')
  })

  it('keeps approved and discarded outcomes readable on retry', async () => {
    const controller = createPlanReviewController()
    const approvedId = controller.create('plan-approved-key')
    const discardedId = controller.create('plan-discarded-key')
    controller.resolve(approvedId, { status: 'approved' })
    controller.resolve(discardedId, { status: 'discarded' })
    const { bridge } = makeBridge({ planReview: controller })

    expect(await textOf(call(bridge, 'wait_plan_review', { plan_review_id: approvedId }))).toContain(
      '"status":"approved"'
    )
    expect(await textOf(call(bridge, 'wait_plan_review', { plan_review_id: approvedId }))).toContain(
      '"status":"approved"'
    )
    expect(await textOf(call(bridge, 'wait_plan_review', { plan_review_id: discardedId }))).toContain(
      '"status":"discarded"'
    )
  })

  it('rejects stale, unknown and cross-conversation IDs with one stable error', async () => {
    const owner = createPlanReviewController()
    const foreignId = owner.create('foreign-plan-key')
    const { bridge } = makeBridge({ planReview: createPlanReviewController() })

    for (const reviewId of [foreignId, 'pr_unknown']) {
      const response = await call(bridge, 'wait_plan_review', { plan_review_id: reviewId, wait_seconds: 1 })
      expect(response.result.isError).toBe(true)
      expect(response.result.content[0].text).toContain('plan-review-not-found')
    }
  })

  it('aborts active waits and removes controller waiters when the session ends', async () => {
    const controller = createPlanReviewController()
    const reviewId = controller.create('active-wait-key')
    const { bridge } = makeBridge({ planReview: controller })
    const waiting = call(bridge, 'wait_plan_review', { plan_review_id: reviewId, wait_seconds: 60 })
    await vi.waitFor(() => expect(controller.stats().waiters).toBe(1))

    bridge.endSession()

    expect(await textOf(waiting)).toContain('companion session ended')
    await vi.waitFor(() => expect(controller.stats().waiters).toBe(0))
    expect(controller.stats().pending).toBe(1)
  })
})

describe('repository tools: jail and limits', () => {
  it('numbers file lines and rejects repository escapes', async () => {
    const { bridge } = makeBridge()
    expect(await textOf(call(bridge, 'read_file', { path: 'src/alpha.ts' }))).toContain('1| export const alpha = 1')
    const escaped = await call(bridge, 'read_file', { path: '../../etc/passwd' })
    expect(escaped.result.isError).toBe(true)
    expect(escaped.result.content[0].text).toContain('outside the repository')
  })

  it('rejects symlink read escapes', async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'chatweb-outside-'))
    const link = path.join(repo, 'src', 'secret.txt')
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'must not leak\n')
      symlinkSync(path.join(outside, 'secret.txt'), link)
      const escaped = await call(makeBridge().bridge, 'read_file', { path: 'src/secret.txt' })
      expect(escaped.result.isError).toBe(true)
      expect(escaped.result.content[0].text).toContain('symlink/junction')
    } finally {
      rmSync(link, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('bounds file reads and grep', async () => {
    const large = path.join(repo, 'src', 'grande.txt')
    writeFileSync(large, Buffer.concat([Buffer.from('MARCADOR_GIGANTE\n'), Buffer.alloc(4 * 1024 * 1024, 0x61)]))
    try {
      const { bridge } = makeBridge()
      expect((await call(bridge, 'read_file', { path: 'src/grande.txt' })).result.isError).toBe(true)
      expect(await textOf(call(bridge, 'grep', { pattern: 'MARCADOR_GIGANTE' }))).toContain('no matches')
    } finally {
      rmSync(large, { force: true })
    }
  })

  it('bounds remote regex patterns without blocking the main process', async () => {
    const hostile = path.join(repo, 'src', 'regex-hostile.txt')
    writeFileSync(hostile, `${'a'.repeat(100_000)}!\n`)
    try {
      const { bridge } = makeBridge()
      const startedAt = Date.now()
      const hostileResult = await call(bridge, 'grep', { path: 'src', pattern: '(a+)+$', limit: 200 })
      expect(hostileResult.result.isError).toBe(true)
      expect(hostileResult.result.content[0].text).toMatch(/tempo|regex/i)
      expect(Date.now() - startedAt).toBeLessThan(2000)

      const oversized = await call(bridge, 'grep', { pattern: 'a'.repeat(2049) })
      expect(oversized.result.isError).toBe(true)
      expect(oversized.result.content[0].text).toContain('limit')
    } finally {
      rmSync(hostile, { force: true })
    }
  })

  it('combines branch, worktree and untracked diffs within the jail', async () => {
    const untracked = path.join(repo, 'src', 'new.ts')
    const hugeUntracked = path.join(repo, 'src', 'new-grande.txt')
    writeFileSync(untracked, 'export const added = true\n')
    const seen: string[][] = []
    try {
      const { bridge } = makeBridge({
        runGit: async (args) => {
          seen.push(args)
          if (args[0] === 'diff' && args[1] === 'HEAD') return 'staged + unstaged changes'
          if (args[0] === 'diff') return 'committed branch changes'
          if (args[0] === 'ls-files' && args[1] === '--others') return 'src/new.ts'
          return ''
        },
      })
      const result = await textOf(call(bridge, 'git_diff'))
      expect(result).toContain('committed branch changes')
      expect(result).toContain('staged + unstaged changes')
      expect(result).toContain('diff --git a/src/new.ts b/src/new.ts')
      expect(result).toContain('+export const added = true')
      expect(seen).toContainEqual(['diff', 'origin/main...HEAD'])
      expect(seen).toContainEqual(['diff', 'HEAD'])
      expect(seen).toContainEqual(['ls-files', '--others', '--exclude-standard'])

      const escaped = await call(bridge, 'git_diff', { path: '../../etc/passwd' })
      expect(escaped.result.isError).toBe(true)
      expect(escaped.result.content[0].text).toContain('outside the repository')

      writeFileSync(hugeUntracked, 'x'.repeat(200_000))
      const limitedBridge = makeBridge({
        runGit: async (args) => {
          if (args[0] === 'ls-files' && args[1] === '--others') return 'src/new-grande.txt'
          return ''
        },
      })
      const limited = await textOf(call(limitedBridge.bridge, 'git_diff'))
      expect(limited).toContain('[diff truncated]')
      expect(limited.length).toBeLessThan(181_000)
    } finally {
      rmSync(untracked, { force: true })
      rmSync(hugeUntracked, { force: true })
    }
  })

  it('provides working repository tools and structural maps', async () => {
    const { bridge } = makeBridge({
      runGit: async (args) =>
        args[0] === 'ls-files'
          ? 'package.json\nsrc/alpha.ts\nsrc/main/index.ts\nsrc/renderer/App.tsx'
          : 'fake-git-output',
    })
    expect(await textOf(call(bridge, 'grep', { pattern: 'TODO' }))).toContain('src/alpha.ts:2')
    expect(await textOf(call(bridge, 'glob', { pattern: 'src/**/*.ts' }))).toContain('src/alpha.ts')
    const context = await textOf(call(bridge, 'get_context'))
    expect(context).toContain('fake-git-output')
    expect(context).toContain('## Automatic repository map')
    expect(context).toContain('TypeScript')
    expect(context).toContain('React, Vite, Vitest')
    expect(context).toContain('src/main/index.ts')
    expect(context).toContain('does not mean the content was read')
    expect(await textOf(call(bridge, 'git_diff'))).toContain('fake-git-output')
  })

  it('runs allowlisted checks and cancels them when the session ends', async () => {
    let seenSignal: AbortSignal | undefined
    const { bridge } = makeBridge({
      listChecks: () => [{ name: 'test', description: 'tests' }],
      runCheck: async (_name, signal) => {
        seenSignal = signal
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
        return { exitCode: null, output: 'cancelled', aborted: true }
      },
    })
    const injected = await call(bridge, 'run_check', { name: 'test && rm -rf .' })
    expect(injected.result.isError).toBe(true)
    const running = call(bridge, 'run_check', { name: 'test' })
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    bridge.endSession()
    const endedResult = await textOf(running)
    expect(endedResult).toContain('companion session ended')
    expect(endedResult).not.toContain('cancelled')
    expect(seenSignal?.aborted).toBe(true)
  })

  it('suppresses get_context results completed after the session ends', async () => {
    let release!: () => void
    let started = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { bridge } = makeBridge({
      projectContext: async () => {
        started = true
        await gate
        return 'stale context'
      },
    })
    const running = call(bridge, 'get_context')
    await vi.waitFor(() => expect(started).toBe(true))
    bridge.endSession()
    const result = await textOf(running)
    release()
    expect(result).toContain('companion session ended')
    expect(result).not.toContain('stale context')
  })

  it('returns partial context after uncooperative bootstrap cancellation', async () => {
    let gitSignal: AbortSignal | undefined
    const never = new Promise<never>(() => undefined)
    const { bridge, events } = makeBridge({
      getContextTimeoutMs: 25,
      runGit: async (_args, signal) => {
        gitSignal = signal
        return never
      },
      projectContext: () => never,
      listSkills: () => never,
    })

    const result = await textOf(call(bridge, 'get_context'))

    expect(result).toContain('# Repository context (partial)')
    expect(result).toContain('was stopped to avoid blocking the conversation')
    expect(result).toContain('project-context')
    expect(result).toContain('skills')
    expect(result).toContain('git-status')
    expect(gitSignal?.aborted).toBe(true)
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', name: 'get_context', ok: true }))
  })
})

describe('companion session and prompt', () => {
  it('generates a strong key, hides it from status and connects on the first tool call', async () => {
    const session = createChatGptWebSession({ conversationId: 'conv', cwd: repo })
    try {
      expect(session.sessionKey).toMatch(/^[0-9a-f]{32}$/)
      expect(JSON.stringify(session.info())).not.toContain(session.sessionKey)
      expect(session.info().state).toBe('arming')
      expect(session.info().pairingRequired).toBe(true)
      await session.bridge.callTool('get_context', {})
      expect(session.info().state).toBe('live')
      expect(session.info().pairingRequired).toBe(false)
      expect(session.info().toolCalls).toBe(1)
    } finally {
      session.end()
    }
  })

  it('reports actual completions per session without bootstrap alerts', async () => {
    const completedA = vi.fn(() => {
      throw new Error('broken observer')
    })
    const completedB = vi.fn()
    const first = createChatGptWebSession({
      conversationId: 'conv-a',
      cwd: repo,
      onTurnCompleted: completedA,
    })
    const second = createChatGptWebSession({
      conversationId: 'conv-b',
      cwd: repo,
      onTurnCompleted: completedB,
    })
    try {
      await first.bridge.callTool('get_context', {})
      expect(completedA).not.toHaveBeenCalled()
      await first.bridge.callTool('notify_turn_complete', { idempotency_key: 'turn-a-001' })
      await first.bridge.callTool('notify_turn_complete', { idempotency_key: 'turn-a-001' })
      await second.bridge.callTool('notify_turn_complete', { idempotency_key: 'turn-b-001' })

      expect(completedA).toHaveBeenCalledTimes(1)
      expect(completedA).toHaveBeenCalledWith({ idempotencyKey: 'turn-a-001' })
      expect(completedB).toHaveBeenCalledTimes(1)
      expect(completedB).toHaveBeenCalledWith({ idempotencyKey: 'turn-b-001' })
      expect(first.info().state).toBe('live')
      expect(second.info().state).toBe('live')
    } finally {
      first.end()
      second.end()
    }
  })

  it('keeps waiting after routed tool failures', async () => {
    const session = createChatGptWebSession({ conversationId: 'conv-error', cwd: repo })
    try {
      const result = (await session.bridge.callTool('read_file', { path: '../../etc/passwd' })) as {
        isError?: boolean
      }
      expect(result.isError).toBe(true)
      expect(session.info().state).toBe('arming')
    } finally {
      session.end()
    }
  })

  it('finishes onboarding after remote first-message confirmation', () => {
    const session = createChatGptWebSession({ conversationId: 'conv-paired', cwd: repo })
    try {
      expect(session.info().pairingRequired).toBe(true)
      session.markPaired()
      expect(session.info().pairingRequired).toBe(false)
    } finally {
      session.end()
    }
  })

  it('derives stable tunnel/conversation keys without persisting another secret', () => {
    const base = {
      platformKey: 'sk-platform-secret',
      tunnelId: 'tunnel-a',
      conversationId: 'conv-a',
      sessionScope: '0123456789abcdef0123456789abcdef',
    }
    const first = deriveResumableSessionKey(base)
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(deriveResumableSessionKey(base)).toBe(first)
    expect(deriveResumableSessionKey({ ...base, conversationId: 'conv-b' })).not.toBe(first)
    expect(deriveResumableSessionKey({ ...base, tunnelId: 'tunnel-b' })).not.toBe(first)
    expect(deriveResumableSessionKey({ ...base, platformKey: 'sk-rotated' })).not.toBe(first)
    expect(deriveResumableSessionKey({ ...base, sessionScope: 'rotated-scope' })).not.toBe(first)

    const resumed = createChatGptWebSession({
      conversationId: 'conv-a',
      cwd: repo,
      sessionKey: first,
      pairingRequired: false,
    })
    try {
      expect(resumed.sessionKey).toBe(first)
      expect(resumed.info().pairingRequired).toBe(false)
      expect(JSON.stringify(resumed.info())).not.toContain(first)
    } finally {
      resumed.end()
    }
  })

  it('instructs normal conversation and explicit delivery without a loop protocol', () => {
    const prompt = buildCompanionPrompt({ appName: 'Maestrly Bridge', sessionKey: 'session-123' })
    expect(prompt).toContain('Maestrly Bridge')
    expect(prompt).toContain('session-123')
    expect(prompt).toContain('send_to_maestrly')
    expect(prompt).toContain('wait_plan_review')
    expect(prompt).toContain('plan_review_id')
    expect(prompt).toContain('Do not call `notify_turn_complete` between versions')
    expect(prompt).toContain('`start_review_loop` by itself')
    expect(prompt).toContain('definitions and callers')
    expect(prompt).toContain('gaps')
    expect(prompt).toContain('confidence')
    expect(prompt).toContain('Converse normally')
    expect(prompt).toContain('DURABLE PROJECT MEMORY')
    expect(prompt).toContain('Skip memory for trivial or self-contained requests')
    expect(prompt).toContain('notify_turn_complete')
    expect(prompt).toMatch(/search-\* and\s+api-get are global/)
    expect(prompt).toContain('get_conversation_context')
    expect(prompt).toContain('search_conversation')
    expect(prompt).toContain('read_conversation')
    expect(prompt).toContain('does not replace `get_context`, `git_diff`, `grep`/`glob` or `read_file`')
    expect(prompt).toContain('Only use MCP write for a user-requested mutation')
    expect(prompt).toContain('final tool call\n  before the final response')
    expect(prompt).toContain('Skip this call during initial pairing validation')
    expect(prompt).toContain('Validate pairing')
    expect(prompt).not.toContain('next_input')
    expect(prompt).not.toContain('instruction_id')
    expect(prompt).not.toContain('/repo')
  })

})

// ----------------------------------------------------------------------------
// Automatic bridge review: schemas, iteration checkpoints, sanitization and lifecycle.
// ----------------------------------------------------------------------------

/** Deterministic fake controller; actual controller behavior is tested separately. */
function makeFakeLoop(overrides: Record<string, unknown> = {}) {
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
      assistantMessageId: 'assistant-1',
      executorSummary: 'summary',
      madeProgress: true,
      beforeFingerprint: 'fp-before',
      afterFingerprint: 'fp-after',
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
    discoverFrontendPreviews: vi.fn(async () => []),
    visualBrowser: vi.fn(() => null),
    showVisualPreview: vi.fn(() => false),
    ...overrides,
  } as unknown as ReturnType<typeof createChatGptWebBridge> extends never ? never : any
}

async function reviewCall(
  bridge: ReturnType<typeof createChatGptWebBridge>,
  name: string,
  args: Record<string, unknown>
) {
  return (await bridge.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })) as { result: { content: Array<{ text: string }>; isError?: boolean } }
}

describe('bridge review loop protocol and sanitization', () => {
  it('fails browser tools closed outside frontend scope and blocks interaction in Inspect', async () => {
    const noVisual = makeFakeLoop()
    const { bridge: off } = makeBridge({ reviewLoop: noVisual as never, browserCapability: 'off' })
    expect((await reviewCall(off, 'browser_snapshot', {})).result.content[0].text).toContain('Off')

    const visual = {
      snapshot: vi.fn(async () => ({ url: 'http://localhost:5173/', elements: [] })),
      screenshot: vi.fn(async () => ({
        data: 'iVBORw0KGgo=',
        metadata: {
          url: 'http://localhost:5173/',
          viewport: { width: 10, height: 10 },
          scroll: { x: 0, y: 0, maxX: 0, maxY: 0 },
        },
      })),
      click: vi.fn(async () => undefined),
    }
    const inspectLoop = makeFakeLoop({ visualBrowser: vi.fn(() => visual) })
    const { bridge: inspect } = makeBridge({ reviewLoop: inspectLoop as never, browserCapability: 'inspect' })
    expect((await reviewCall(inspect, 'browser_click', { ref: 0 })).result.content[0].text).toContain('Interact')
    expect(visual.click).not.toHaveBeenCalled()

    const navigate = vi.fn(async (url: string) => ({ url }))
    const reload = vi.fn(async () => ({ moved: false, url: 'http://localhost:5173/' }))
    const navigableVisual = { ...visual, navigate, reload }
    const navigableInspectLoop = makeFakeLoop({ visualBrowser: vi.fn(() => navigableVisual) })
    const { bridge: navigableInspect } = makeBridge({
      reviewLoop: navigableInspectLoop as never,
      browserCapability: 'inspect',
    })
    expect(
      (await reviewCall(navigableInspect, 'browser_navigate', { url: 'http://localhost:5173/other' })).result.content[0]
        .text
    ).toContain('Interact')
    expect((await reviewCall(navigableInspect, 'browser_reload', {})).result.content[0].text).toContain('Interact')
    expect(navigate).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()

    const { bridge: navigableInteract } = makeBridge({
      reviewLoop: makeFakeLoop({ visualBrowser: vi.fn(() => navigableVisual) }) as never,
      browserCapability: 'interact',
    })
    expect(
      (await reviewCall(navigableInteract, 'browser_navigate', { url: 'http://localhost:5173/other' })).result.isError
    ).not.toBe(true)
    expect((await reviewCall(navigableInteract, 'browser_reload', {})).result.isError).not.toBe(true)
    expect(navigate).toHaveBeenCalledWith('http://localhost:5173/other')
    expect(reload).toHaveBeenCalledTimes(1)

    inspect.setReviewIteration('rl_frontend', 1)
    await reviewCall(inspect, 'browser_snapshot', {})
    const screenshot = await reviewCall(inspect, 'browser_screenshot', {})
    expect(screenshot.result.content[0] as unknown as { type: string; data: string }).toMatchObject({
      type: 'image',
      data: 'iVBORw0KGgo=',
    })
    expect(inspect.getReviewEvidence('rl_frontend').byIteration[1]).toMatchObject({
      browserSnapshot: 1,
      browserScreenshot: 1,
    })
  })

  it('start frontend requires capability and forwards only the opaque preview_id', async () => {
    const start = vi.fn(async () => ({
      loopId: 'rl_frontend',
      status: 'reviewing',
      iteration: 1,
      maxIterations: 5,
      severityThreshold: 'important',
      reviewScope: 'frontend',
      baseline: { branch: 'main', head: 'abc', workspaceFingerprint: 'fp' },
      executor: { providerId: 'codex', modelId: 'gpt' },
    }))
    const loop = makeFakeLoop({ start })
    const { bridge: off } = makeBridge({ reviewLoop: loop as never, browserCapability: 'off' })
    expect(
      (
        await reviewCall(off, 'start_review_loop', {
          review_scope: 'frontend',
          preview_id: 'preview_opaque',
          idempotency_key: 'frontend-start-001',
        })
      ).result.isError
    ).toBe(true)
    expect(start).not.toHaveBeenCalled()

    const { bridge: inspect } = makeBridge({ reviewLoop: loop as never, browserCapability: 'inspect' })
    expect(
      (
        await reviewCall(inspect, 'start_review_loop', {
          review_scope: 'frontend',
          preview_id: 'preview_opaque',
          idempotency_key: 'frontend-start-002',
        })
      ).result.isError
    ).not.toBe(true)
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewScope: 'frontend',
        previewId: 'preview_opaque',
        idempotencyKey: 'frontend-start-002',
      })
    )

    const rawTarget = await reviewCall(inspect, 'start_review_loop', {
      review_scope: 'frontend',
      target_url: 'http://127.0.0.1:8080/admin',
      idempotency_key: 'frontend-start-003',
    })
    expect(rawTarget.result.isError).toBe(true)
    expect(rawTarget.result.content[0].text).toContain('target_url is not accepted')
    expect(start).toHaveBeenCalledTimes(1)

    const listed = (await inspect.handleMessage({ jsonrpc: '2.0', id: 99, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }
    }
    const startSchema = listed.result.tools.find((tool) => tool.name === 'start_review_loop')?.inputSchema
    expect(startSchema?.properties).not.toHaveProperty('target_url')
  })

  it('returns bounded bootstrap diagnostics as readable tool errors', async () => {
    const loop = makeFakeLoop({
      start: vi.fn(async () => ({
        error:
          'frontend-preview-start-failed:Preview startup timed out.\nCaused by: Process output (tail):\nError: missing module',
      })),
    })
    const { bridge } = makeBridge({ reviewLoop: loop as never, browserCapability: 'inspect' })

    const response = await reviewCall(bridge, 'start_review_loop', {
      review_scope: 'frontend',
      preview_id: 'preview_opaque',
      idempotency_key: 'frontend-start-diagnostic-001',
    })

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('Visual Review could not start.')
    expect(response.result.content[0].text).toContain('Diagnostics:')
    expect(response.result.content[0].text).toContain('Preview startup timed out.')
    expect(response.result.content[0].text).toContain('Error: missing module')
  })

  it('allows curated Interact actions without recording typed text in events', async () => {
    const typed = vi.fn(async () => undefined)
    const loop = makeFakeLoop({ visualBrowser: vi.fn(() => ({ type: typed })) })
    const { bridge, events } = makeBridge({ reviewLoop: loop as never, browserCapability: 'interact' })
    bridge.setReviewIteration('rl_frontend', 1)
    const response = await reviewCall(bridge, 'browser_type', { ref: 2, text: 'visual secret', clear: true })
    expect(response.result.isError).not.toBe(true)
    expect(typed).toHaveBeenCalledWith(2, 'visual secret', true)
    expect(JSON.stringify(events)).not.toContain('visual secret')
    expect(bridge.getReviewEvidence('rl_frontend').byIteration[1]?.browserInteraction).toBe(1)
  })

  it('validates session and idempotency keys for all review tools', async () => {
    const { bridge } = makeBridge({ reviewLoop: makeFakeLoop() as never })
    const list = (await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: {
        tools: Array<{ name: string; inputSchema: { required?: string[] }; annotations?: Record<string, unknown> }>
      }
    }
    for (const tool of list.result.tools) {
      if (tool.name.startsWith('review')) {
        expect(tool.inputSchema.required).toContain('session_key')
      }
    }
    // idempotency_key curta
    const bad = await reviewCall(bridge, 'start_review_loop', { idempotency_key: 'curta' })
    expect(bad.result.isError).toBe(true)
  })

  it('instructs reviewers to continue active loops', async () => {
    const loop = makeFakeLoop({ finish: vi.fn(async () => ({ error: 'loop-not-terminal' })) })
    const { bridge } = makeBridge({ reviewLoop: loop as never })

    const response = await reviewCall(bridge, 'finish_review_loop', {
      loop_id: 'rl_test',
      result: 'cancelled',
      summary: 'I could not finish in this response.',
      idempotency_key: 'finish-cancelled-001',
    })

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('still active')
    expect(response.result.content[0].text).toContain('cancelled is only valid')
  })

  it('declares mutable start/finish, destructive submit and read-only wait annotations', async () => {
    const { bridge } = makeBridge({ reviewLoop: makeFakeLoop() as never })
    const list = (await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> }
    }
    const byName = (name: string) => list.result.tools.find((tool) => tool.name === name)
    expect(byName('start_review_loop')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(byName('submit_review_fix')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(byName('wait_review_fix')?.annotations).toMatchObject({ readOnlyHint: true })
    expect(byName('finish_review_loop')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
  })

  it('validates finding count, total size and relative paths', async () => {
    const { bridge } = makeBridge({ reviewLoop: makeFakeLoop() as never })
    const base = { loop_id: 'rl_test', iteration: 1, idempotency_key: 'valid-key-123' }
    // No findings.
    expect((await reviewCall(bridge, 'submit_review_fix', base)).result.isError).toBe(true)
    // Empty findings.
    expect((await reviewCall(bridge, 'submit_review_fix', { ...base, findings: [] })).result.isError).toBe(true)
    // paths inseguros
    expect(
      (
        await reviewCall(bridge, 'submit_review_fix', {
          ...base,
          findings: [{ id: 'f1', severity: 'blocking', title: 't', details: 'd', paths: ['../escape.ts'] }],
        })
      ).result.isError
    ).toBe(true)
    // > 50 findings
    const many = Array.from({ length: 51 }, (_, i) => ({
      id: `f${i}`,
      severity: 'blocking',
      title: `t${i}`,
      details: `d${i}`,
    }))
    expect((await reviewCall(bridge, 'submit_review_fix', { ...base, findings: many })).result.isError).toBe(true)
    // ok
    expect(
      (
        await reviewCall(bridge, 'submit_review_fix', {
          ...base,
          findings: [{ id: 'f1', severity: 'blocking', title: 't', details: 'd' }],
        })
      ).result.isError
    ).not.toBe(true)
    // wait_seconds exceeds the cap.
    expect(
      (await reviewCall(bridge, 'wait_review_fix', { loop_id: 'rl_test', job_id: 'j_1', wait_seconds: 99 })).result
        .isError
    ).toBe(true)
    // finish without summary.
    expect(
      (
        await reviewCall(bridge, 'finish_review_loop', {
          loop_id: 'rl_test',
          result: 'clean',
          idempotency_key: 'valid-key-456',
        })
      ).result.isError
    ).toBe(true)
  })

  it('scopes evidence checkpoints per loop and iteration', async () => {
    const loop = makeFakeLoop()
    const { bridge } = makeBridge({ reviewLoop: loop as never })
    await call(bridge, 'get_context')
    // Loop A, iteration one.
    bridge.setReviewIteration('rl_a', 1)
    await call(bridge, 'git_diff')
    await call(bridge, 'glob', { pattern: 'src/**/*.ts' })
    await call(bridge, 'read_file', { path: 'src/alpha.ts' })
    expect(bridge.getReviewEvidence('rl_a').byIteration[1]).toEqual({ diff: 1, search: 1, read: 1 })
    // Loop B starts with a fresh evidence bucket.
    bridge.setReviewIteration('rl_b', 1)
    expect(bridge.getReviewEvidence('rl_b').byIteration[1]).toBeUndefined()
    // Clearing A does not erase the active B pointer.
    bridge.clearReviewIteration('rl_a')
    await call(bridge, 'git_diff')
    expect(bridge.getReviewEvidence('rl_b').byIteration[1]).toEqual({ diff: 1, search: 0, read: 0 })
    // Forgetting removes only A.
    bridge.forgetReviewLoop('rl_a')
    expect(bridge.getReviewEvidence('rl_a').byIteration).toEqual({})
    expect(bridge.getReviewEvidence('rl_b').byIteration[1]).toEqual({ diff: 1, search: 0, read: 0 })
    bridge.setReviewIteration(null, null)
  })

  /**
   * runGit passes until arm(); subsequent calls wait at the gate.
   * This isolates context bootstrap Git calls from the tool under test. waitEntered()
   * resolves at the first await, after ownership has been captured.
   */
  function gatedGit() {
    let armed = false
    let entered = 0
    let release!: () => void
    let notifyEntered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const enteredGate = new Promise<void>((resolve) => {
      notifyEntered = resolve
    })
    return {
      arm: () => {
        armed = true
      },
      release: () => release(),
      waitEntered: () => enteredGate,
      runGit: async () => {
        if (armed) {
          entered += 1
          if (entered === 1) notifyEntered()
          await gate
        }
        return 'fake-git-output'
      },
    }
  }

  it('credits tools started in A to A even after B starts', async () => {
    const g = gatedGit()
    const { bridge } = makeBridge({ runGit: g.runGit })
    await call(bridge, 'get_context')
    bridge.setReviewIteration('rl_a', 1)
    g.arm()
    // The tool starts in A and remains pending while awaiting git.
    const pending = call(bridge, 'git_diff', {})
    await g.waitEntered() // A's owner has already been captured.
    // B becomes active before completion.
    bridge.setReviewIteration('rl_b', 1)
    g.release()
    expect((await pending).result.isError).not.toBe(true)
    // Credit belongs to A/1; B remains empty.
    expect(bridge.getReviewEvidence('rl_a').byIteration[1]).toEqual({ diff: 1, search: 0, read: 0 })
    expect(bridge.getReviewEvidence('rl_b').byIteration[1]).toBeUndefined()
  })

  it('credits late iteration-one tools only to iteration one', async () => {
    const g = gatedGit()
    const { bridge } = makeBridge({ runGit: g.runGit })
    await call(bridge, 'get_context')
    bridge.setReviewIteration('rl_a', 1)
    g.arm()
    const pending = call(bridge, 'git_diff', {})
    await g.waitEntered()
    // Advance the same loop to iteration two before completion.
    bridge.setReviewIteration('rl_a', 2)
    g.release()
    expect((await pending).result.isError).not.toBe(true)
    expect(bridge.getReviewEvidence('rl_a').byIteration[1]).toEqual({ diff: 1, search: 0, read: 0 })
    expect(bridge.getReviewEvidence('rl_a').byIteration[2]).toBeUndefined()
  })

  it('does not recreate forgotten loop buckets for late tools', async () => {
    const g = gatedGit()
    const { bridge } = makeBridge({ runGit: g.runGit })
    await call(bridge, 'get_context')
    bridge.setReviewIteration('rl_a', 1)
    g.arm()
    const pending = call(bridge, 'git_diff', {})
    await g.waitEntered()
    // Permanent forgetting prevents pending calls from restoring state.
    bridge.forgetReviewLoop('rl_a')
    g.release()
    expect((await pending).result.isError).not.toBe(true) // The tool completes normally for the caller.
    expect(bridge.getReviewEvidence('rl_a').byIteration).toEqual({})
    // The evidence bucket remains absent.
    expect(bridge.getReviewEvidence('rl_a').checks).toEqual([])
  })

  it('does not expose checks started in A in B', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { bridge } = makeBridge({
      listChecks: () => [{ name: 'test', description: 'Tests' }],
      runCheck: async () => {
        entered()
        await gate
        return { exitCode: 0, output: 'ok' }
      },
    })
    await call(bridge, 'get_context')
    bridge.setReviewIteration('rl_a', 1)
    const pending = call(bridge, 'run_check', { name: 'test' })
    await enteredGate
    // B starts before the check completes.
    bridge.setReviewIteration('rl_b', 1)
    release()
    expect((await pending).result.isError).not.toBe(true)
    expect(bridge.getReviewEvidence('rl_a').checks).toEqual(['test'])
    expect(bridge.getReviewEvidence('rl_b').checks).toEqual([])
  })

  it('does not retroactively assign tools started outside a loop', async () => {
    const g = gatedGit()
    const { bridge } = makeBridge({ runGit: g.runGit })
    await call(bridge, 'get_context')
    g.arm()
    // No iteration assignment means null ownership at admission.
    const pending = call(bridge, 'git_diff', {})
    await g.waitEntered()
    // A loop starts while the tool is running.
    bridge.setReviewIteration('rl_late', 1)
    g.release()
    expect((await pending).result.isError).not.toBe(true)
    // No retroactive evidence attribution.
    expect(bridge.getReviewEvidence('rl_late').byIteration[1]).toBeUndefined()
  })

  it('keeps findings and prompts out of events and counts only jobs and iterations', async () => {
    const loop = makeFakeLoop()
    const { bridge, events } = makeBridge({ reviewLoop: loop as never })
    await reviewCall(bridge, 'start_review_loop', { idempotency_key: 'valid-key-100' })
    await reviewCall(bridge, 'submit_review_fix', {
      loop_id: 'rl_test',
      iteration: 1,
      findings: [{ id: 'f1', severity: 'blocking', title: 'SECRET TITLE', details: 'SECRET DETAILS' }],
      idempotency_key: 'valid-key-101',
    })
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain('SECRET TITLE')
    expect(serialized).not.toContain('SECRET DETAILS')
    expect(serialized).toContain('review-fix-started')
    expect(serialized).toContain('review-loop-started')
    expect(bridge.stats().reviewJobs).toBe(1)
    expect(bridge.stats().reviewIterations).toBe(1)
  })

  it('aborts long-poll waits through session lifecycle', async () => {
    let releaseWait!: () => void
    new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    const loop = makeFakeLoop({
      wait: vi.fn(async (_input: unknown, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return { error: 'session-ended' }
      }),
    })
    const { bridge } = makeBridge({ reviewLoop: loop as never })
    const running = reviewCall(bridge, 'wait_review_fix', { loop_id: 'rl_test', job_id: 'j_1' })
    await vi.waitFor(() => expect(loop.wait).toHaveBeenCalled())
    bridge.endSession()
    const result = await running
    expect(result.result.isError).toBe(true)
    expect(result.result.content[0].text).toContain('companion session')
    releaseWait()
  })

  it('serializes terminal wait states with stop reasons', async () => {
    const loop = makeFakeLoop({
      wait: vi.fn(async () => ({
        status: 'cancelled',
        iteration: 2,
        startedAt: 10,
        finishedAt: 20,
        madeProgress: false,
        beforeFingerprint: 'fp-b',
        afterFingerprint: 'fp-a',
        nextIteration: 3,
        canContinue: false,
        stopReason: 'cancelled',
      })),
    })
    const { bridge } = makeBridge({ reviewLoop: loop as never })
    const out = await reviewCall(bridge, 'wait_review_fix', { loop_id: 'rl_test', job_id: 'j_1' })
    expect(out.result.isError).not.toBe(true)
    const parsed = JSON.parse(out.result.content[0].text) as {
      status: string
      canContinue: boolean
      stopReason?: string
    }
    expect(parsed).toMatchObject({ status: 'cancelled', canContinue: false, stopReason: 'cancelled' })
    // The emitted event reflects the terminal state.
    expect(loop.wait).toHaveBeenCalledWith(
      expect.objectContaining({ loopId: 'rl_test', jobId: 'j_1' }),
      expect.any(AbortSignal)
    )
  })

  it('maps review-loop-failed to readable errors without leaking raw content', async () => {
    const loop = makeFakeLoop({
      submit: vi.fn(async () => ({ error: 'review-loop-failed' })),
    })
    const { bridge, events } = makeBridge({ reviewLoop: loop as never })
    const out = await reviewCall(bridge, 'submit_review_fix', {
      loop_id: 'rl_test',
      iteration: 2,
      findings: [{ id: 'f1', severity: 'blocking', title: 'SECRET TITLE', details: 'SECRET DETAILS' }],
      idempotency_key: 'valid-key-103',
    })
    expect(out.result.isError).toBe(true)
    const text = out.result.content[0].text
    expect(text).toContain('failed during the round')
    expect(text).toContain('finish_review_loop(result="failed")')
    // No stack, findings, or prompt in the error.
    expect(text).not.toContain('at Error')
    expect(text).not.toContain('SECRET TITLE')
    expect(text).not.toContain('SECRET DETAILS')
    // Rejected submissions emit no job events.
    expect(JSON.stringify(events)).not.toContain('review-fix-started')
  })

  it('serializes failed waits with sanitized events', async () => {
    const loop = makeFakeLoop({
      wait: vi.fn(async () => ({
        status: 'failed',
        iteration: 1,
        startedAt: 10,
        finishedAt: 20,
        assistantMessageId: 'assistant-1',
        executorSummary: 'INTERNAL ERROR: provider failed (sensitive stack trace)',
        madeProgress: false,
        beforeFingerprint: 'fp-b',
        afterFingerprint: 'fp-a',
        nextIteration: 2,
        canContinue: false,
        stopReason: 'failed',
      })),
    })
    const { bridge, events } = makeBridge({ reviewLoop: loop as never })
    const out = await reviewCall(bridge, 'wait_review_fix', { loop_id: 'rl_test', job_id: 'j_1' })
    expect(out.result.isError).not.toBe(true)
    const parsed = JSON.parse(out.result.content[0].text) as {
      status: string
      canContinue: boolean
      stopReason?: string
      nextIteration: number
    }
    expect(parsed).toMatchObject({
      status: 'failed',
      canContinue: false,
      stopReason: 'failed',
      nextIteration: 2,
    })
    // Sanitized events carry metadata without raw error text.
    const serialized = JSON.stringify(events)
    expect(serialized).toContain('review-fix-finished')
    expect(serialized).toContain('"status":"failed"')
    expect(serialized).not.toContain('sensitive stack trace')
    expect(serialized).not.toContain('provider failed')
  })

  it('lists review tools without hooks but rejects their execution', async () => {
    const { bridge } = makeBridge()
    const list = (await bridge.handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> }
    }
    // Schemas stay stable for cached tools/list; every capability appears.
    for (const name of ['start_review_loop', 'submit_review_fix', 'wait_review_fix', 'finish_review_loop']) {
      const tool = list.result.tools.find((candidate) => candidate.name === name)
      expect(tool).toBeDefined()
      expect(tool?.inputSchema.properties).toHaveProperty('session_key')
    }
    // Execution still requires a controller and returns readable refusals otherwise.
    const refused = await reviewCall(bridge, 'submit_review_fix', {
      loop_id: 'rl_test',
      iteration: 1,
      findings: [{ id: 'f1', severity: 'blocking', title: 't', details: 'd' }],
      idempotency_key: 'valid-key-102',
    })
    expect(refused.result.isError).toBe(true)
    expect(refused.result.content[0].text).toContain('review loop is unavailable')
  })

  it('documents review-loop pairing protocols', () => {
    const prompt = buildCompanionPrompt({ appName: 'Maestrly Bridge', sessionKey: 'session-123' })
    expect(prompt).toContain('start_review_loop')
    expect(prompt).toContain('submit_review_fix')
    expect(prompt).toContain('wait_review_fix')
    expect(prompt).toContain('finish_review_loop')
    expect(prompt).toContain('git_diff')
    expect(prompt).toContain('optional')
    expect(prompt).toContain('actual cancellation')
    expect(prompt).toContain('never use it merely because the current response is ending')
    expect(prompt).toContain('review_scope="frontend"')
    expect(prompt).toContain('browser_list_tabs')
    expect(prompt).toContain('start_project_environment')
    expect(prompt).toContain('explicit request')
    expect(prompt).toContain('Never pass localhost URLs directly or scan ports')
    expect(prompt).toContain('NEW browser_snapshot + browser_screenshot')
    expect(prompt).toContain('approved local origin')
  })
})

describe('external gateway: fail closed, diagnostics and lifecycle', () => {
  it('omits sensitive downstream arguments from events', async () => {
    const { bridge, events } = makeBridge({
      external: {
        listCapabilities: () => ({}),
        searchMcpTools: () => ({}),
        callMcpRead: () => 'ok',
        callMcpWrite: () => 'created',
        gitRead: () => 'ok',
        ghRead: () => 'ok',
      },
    })
    await bridge.callTool('call_mcp_write_tool', {
      server_id: 'jira',
      tool_name: 'create_issue',
      arguments: { token: 'never-log-me', body: 'sensitive page content' },
    })
    const event = events.find((item) => item.kind === 'tool-call' && item.name === 'call_mcp_write_tool')
    expect(event).toMatchObject({
      kind: 'tool-call',
      args: { server_id: 'jira', tool_name: 'create_issue', access: 'write', argument_keys: 2 },
    })
    expect(JSON.stringify(event)).not.toContain('never-log-me')
    expect(JSON.stringify(event)).not.toContain('sensitive page content')
  })

  it('aborts external calls and disposes adapters on shutdown', async () => {
    const dispose = vi.fn()
    let seenSignal: AbortSignal | undefined
    const { bridge } = makeBridge({
      external: {
        listCapabilities: () => ({}),
        searchMcpTools: () => ({}),
        callMcpRead: () => 'ok',
        callMcpWrite: () => 'ok',
        gitRead: (_args, signal) => {
          seenSignal = signal
          return new Promise(() => {})
        },
        ghRead: () => 'ok',
        dispose,
      },
    })
    const pending = bridge.callTool('git_read', { operation: 'status' })
    await vi.waitFor(() => expect(seenSignal).toBeDefined())
    bridge.endSession()
    expect(seenSignal?.aborted).toBe(true)
    expect((await pending).isError).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('bridge companion multi-root', () => {
  it('resolves worktree prefixes and blocks symlink escape', async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'chatweb-multi-'))
    const backend = path.join(fixture, 'backend-root')
    const frontend = path.join(fixture, 'frontend-root')
    const aggregator = path.join(fixture, 'aggregator')
    mkdirSync(backend)
    mkdirSync(frontend)
    mkdirSync(aggregator)
    writeFileSync(path.join(backend, 'api.ts'), 'export const api = true\n')
    writeFileSync(path.join(frontend, 'ui.ts'), 'export const ui = true\n')
    writeFileSync(path.join(fixture, 'outside.txt'), 'secret\n')
    symlinkSync(backend, path.join(aggregator, 'backend'))
    symlinkSync(frontend, path.join(aggregator, 'frontend'))
    symlinkSync(path.join(fixture, 'outside.txt'), path.join(backend, 'escape.txt'))
    try {
      const scope = await createRepositoryScope({
        id: 'conv',
        workspaceId: 'ws',
        name: 'multi',
        branch: 'main',
        mode: 'local',
        experience: 'standard',
        cwd: aggregator,
        status: 'idle',
        createdAt: 1,
        archived: 0,
        pinnedAt: null,
        lastActivityAt: 1,
        isMulti: 1,
        repos: [
          {
            workspaceId: 'b',
            repoTop: backend,
            branch: 'feature',
            base: 'origin/main',
            worktreePath: backend,
            linkName: 'backend',
          },
          {
            workspaceId: 'f',
            repoTop: frontend,
            branch: 'feature',
            base: 'origin/main',
            worktreePath: frontend,
            linkName: 'frontend',
          },
        ],
      } satisfies Conversation)
      const gitRead = vi.fn(async (args: Record<string, unknown>) => ({
        data: {
          text:
            args.repo === 'backend'
              ? 'diff --git a/src/new-backend.ts b/src/new-backend.ts\n+export const backend = true'
              : 'diff --git a/src/new-frontend.ts b/src/new-frontend.ts\n+export const frontend = true',
        },
      }))
      const bridge = createChatGptWebBridge({
        cwd: aggregator,
        repositoryScope: scope,
        external: {
          listCapabilities: () => ({}),
          searchMcpTools: () => ({}),
          callMcpRead: () => 'ok',
          callMcpWrite: () => 'ok',
          gitRead,
          ghRead: () => 'ok',
        },
      })
      expect((await bridge.callTool('read_file', { path: 'backend/api.ts' })).content[0].text).toContain('api = true')
      const missingRepoPrefix = await bridge.callTool('read_file', { path: 'src/api.ts' })
      expect(missingRepoPrefix.isError).toBe(true)
      expect(missingRepoPrefix.content[0].text).toContain('list_external_capabilities (backend, frontend)')
      expect((await bridge.callTool('glob', { pattern: '**/*.ts' })).content[0].text).toContain('backend/api.ts')
      expect((await bridge.callTool('grep', { pattern: 'export const' })).content[0].text).toContain('frontend/ui.ts')
      expect((await bridge.callTool('grep', { pattern: 'api', path: 'backend' })).content[0].text).toContain(
        'backend/api.ts'
      )
      expect((await bridge.callTool('read_file', { path: 'backend/escape.txt' })).isError).toBe(true)
      const allDiff = await bridge.callTool('git_diff', {})
      expect(allDiff.content[0].text).toContain('new-backend.ts')
      expect(allDiff.content[0].text).toContain('new-frontend.ts')
      expect(gitRead).toHaveBeenCalledTimes(2)
      expect(gitRead.mock.calls.map(([args]) => args.repo)).toEqual(['backend', 'frontend'])
      await bridge.callTool('git_diff', { repo: 'backend' })
      expect(gitRead).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'diff', repo: 'backend', ref: 'origin/main' }),
        expect.any(AbortSignal)
      )
      const invalidRepo = await bridge.callTool('git_diff', { repo: 'owner/repo' })
      expect(invalidRepo.isError).toBe(true)
      expect(invalidRepo.content[0].text).toContain('not owner/repo')
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
