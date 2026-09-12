import { jsonSchema, tool, type ToolSet } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  appClose: vi.fn(async () => {}),
  mcpClose: vi.fn(async () => {}),
  buildAppTools: vi.fn(),
  buildMcpTools: vi.fn(),
  buildModelSkillRuntime: vi.fn(),
  brokerAssert: vi.fn(async () => {}),
}))

function hostTool(name: string) {
  return tool({
    description: name,
    inputSchema: jsonSchema({ type: 'object', properties: {} }),
    execute: vi.fn(async () => `${name}:ok`),
  })
}

vi.mock('../../src/main/chat/mcp', () => ({
  buildAppTools: h.buildAppTools,
  buildMcpTools: h.buildMcpTools,
}))
vi.mock('../../src/main/store', () => ({
  getConvUiPrefs: vi.fn(() => ({ chat: { tools: { mcpDisabled: ['disabled-server'] } } })),
}))
vi.mock('../../src/main/chat/image-interpreter', () => ({
  hasConfiguredImageInterpreter: vi.fn(() => false),
  describeEphemeralToolImage: vi.fn(async () => null),
}))
vi.mock('../../src/main/chat/subagent-profile-model-meta', () => ({
  getSubagentProfileModelMeta: vi.fn(async () => ({ status: 'available', meta: { vision: true } })),
}))
vi.mock('../../src/main/chat/image-gen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/chat/image-gen')>()
  return { ...actual, generateImageToolEnabled: vi.fn(async () => false) }
})
vi.mock('../../src/main/chat/skill-runtime', () => ({
  buildModelSkillRuntime: h.buildModelSkillRuntime,
}))

import { buildMaestroWorkerTools } from '../../src/main/chat/maestro-worker-tools'

describe('Maestro full worker tool runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const appTools: ToolSet = {
      browser_click: hostTool('browser_click'),
      terminal_run: hostTool('terminal_run'),
      terminal_focus: hostTool('terminal_focus'),
      notes_write_page: hostTool('notes_write_page'),
    }
    const mcpTools: ToolSet = {
      remote_mutate: hostTool('remote_mutate'),
      mcp_search: hostTool('mcp_search'),
      mcp_call: hostTool('mcp_call'),
    }
    h.buildAppTools.mockResolvedValue({ tools: appTools, close: h.appClose })
    h.buildMcpTools.mockResolvedValue({ tools: mcpTools, close: h.mcpClose })
    h.buildModelSkillRuntime.mockResolvedValue({
      skills: [{ name: 'frontend-design' }],
      catalog: '# Available project skills\n- frontend-design: Design intentional interfaces.',
      tools: { use_skill: hostTool('use_skill') },
    })
  })

  it('builds a child-only Agent catalog with all operational built-ins, app tools and enabled MCPs', async () => {
    const runtime = await buildMaestroWorkerTools({
      conversationId: 'conv-1',
      projectId: 'workspace-1',
      cwd: '/repo',
      parentMessageId: 'assistant-1',
      delegationId: 'delegate-1',
      label: 'Frontend reviewer',
      profile: {
        version: 1,
        agentName: 'reviewer',
        effective: {
          providerId: 'openai',
          modelId: 'gpt-worker',
          configuredEffort: 'off',
          sentEffort: null,
          source: 'maestro-resource',
          candidateIndex: 0,
        },
        attempts: [],
      },
      broker: { assert: h.brokerAssert } as never,
      signal: new AbortController().signal,
    })

    expect(h.buildAppTools).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        mode: 'agent',
        exclude: new Set(['review_plan', 'terminal_focus']),
        workerScope: expect.objectContaining({ id: 'delegate-1', conversationId: 'conv-1' }),
      })
    )
    expect(h.buildMcpTools).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'agent',
        disabledIds: new Set(['disabled-server']),
      })
    )
    expect([...runtime.allowedToolNames]).toEqual(
      expect.arrayContaining([
        'read',
        'grep',
        'glob',
        'bash',
        'write',
        'edit',
        'webfetch',
        'browser_click',
        'terminal_run',
        'notes_write_page',
        'remote_mutate',
        'mcp_search',
        'mcp_call',
        'use_skill',
      ])
    )
    for (const forbidden of [
      'ask_question',
      'task',
      'delegate',
      'git_diff',
      'review_plan',
      'todo_write',
      'submit_review',
      'terminal_focus',
    ]) {
      expect(runtime.allowedToolNames.has(forbidden), forbidden).toBe(false)
    }
    expect(runtime.deferredToolNames).toEqual(
      new Set(['remote_mutate', 'mcp_search', 'mcp_call', 'browser_click', 'terminal_run', 'notes_write_page'])
    )
    expect(runtime.skillCatalog).toContain('frontend-design')
    expect(h.buildModelSkillRuntime).toHaveBeenCalledWith({ cwd: '/repo', conversationId: 'conv-1' })

    await runtime.close()
    await runtime.close()
    expect(h.appClose).toHaveBeenCalledOnce()
    expect(h.mcpClose).toHaveBeenCalledOnce()
  })

  it('closes the in-process app catalog when external MCP setup fails', async () => {
    h.buildMcpTools.mockRejectedValueOnce(new Error('mcp failed'))
    await expect(
      buildMaestroWorkerTools({
        conversationId: 'conv-1',
        projectId: 'workspace-1',
        cwd: '/repo',
        parentMessageId: 'assistant-1',
        delegationId: 'delegate-failed',
        label: 'Worker',
        profile: {
          version: 1,
          agentName: 'worker',
          effective: {
            providerId: 'openai',
            modelId: 'gpt-worker',
            configuredEffort: 'off',
            sentEffort: null,
            source: 'maestro-resource',
            candidateIndex: 0,
          },
          attempts: [],
        },
        broker: { assert: h.brokerAssert } as never,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow('mcp failed')
    expect(h.appClose).toHaveBeenCalledOnce()
  })
})
