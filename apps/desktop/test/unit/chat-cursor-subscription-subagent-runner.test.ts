import { abortCursorAccountRuns } from '../../src/main/chat/cursor-subscription/account-runs'
import { describe, expect, it, vi } from 'vitest'
import type { AgentOptions, SDKMessage } from '@cursor/sdk'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { SubagentExecutionSnapshotV1 } from '../../src/shared/subagent-profiles'
import type { ChatAgent } from '../../src/main/chat/agents'
import type { CursorSubscriptionManager } from '../../src/main/chat/cursor-subscription/manager'
import type { SubagentTextUpdate } from '../../src/main/chat/subagent-text-stream'

vi.mock('../../src/main/chat/harness/flags', () => ({ captureHarnessFlags: () => ({}) }))

const cleanup = vi.hoisted(() => ({
  clear: vi.fn(),
  failed: vi.fn(),
  queue: vi.fn(),
}))

vi.mock('../../src/main/chat/cursor-subscription/session-store', () => ({
  clearCursorAgentCleanup: cleanup.clear,
  markCursorAgentCleanupFailed: cleanup.failed,
  queueCursorAgentCleanup: cleanup.queue,
}))

import { runCursorSubagent } from '../../src/main/chat/cursor-subscription/subagent-runner'

const profile: SubagentExecutionSnapshotV1 = {
  version: 1,
  agentName: 'explore',
  effective: {
    providerId: 'cursor-subscription',
    modelId: 'composer-2.5',
    configuredEffort: '',
    sentEffort: null,
    source: 'parent',
    candidateIndex: 0,
  },
  attempts: [],
}

const definition: ChatAgent = {
  name: 'explore',
  description: 'Read-only exploration',
  prompt: 'Investigate.',
  source: 'built-in',
}

describe('Cursor isolated subagent runner', () => {
  it('cancels and releases an active child when its account is retired', async () => {
    let unblock!: () => void
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve
    })
    let streaming = false
    const cancel = vi.fn(async () => {
      unblock()
    })
    const close = vi.fn()
    const release = vi.fn()
    const manager = {
      accountId: 'acc_cursor',
      assertAccountIdentity: vi.fn(),
      resolveModelSelection: vi.fn(async () => ({ modelId: 'composer-2.5', params: [], note: '' })),
      createAgent: vi.fn(async () => ({
        agent: {
          agentId: 'child',
          close,
          send: async () => ({
            supports: (operation: string) => operation === 'stream',
            cancel,
            stream: async function* () {
              streaming = true
              await blocked
              yield { type: 'status', status: 'CANCELLED' } as SDKMessage
            },
          }),
        },
        release,
      })),
      deleteAgent: vi.fn(async () => {}),
    } as unknown as CursorSubscriptionManager
    const parent = new AbortController()
    const outcome = runCursorSubagent({
      manager,
      accountIdentity: { fingerprint: 'user:1', epoch: 1 },
      conversationId: 'parent',
      cwd: '/tmp/project',
      profile,
      definition,
      signal: parent.signal,
      agentName: 'explore',
      task: 'Inspect.',
      readOnly: true,
      tools: {},
      watchdog: { graceMs: 50 },
    }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(streaming).toBe(true))
    abortCursorAccountRuns(manager)
    expect(await outcome).toMatchObject({ message: 'Subagent aborted' })
    expect(parent.signal.aborted).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(manager.deleteAgent).toHaveBeenCalledWith('child')
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0]!)
  })

  it.each([
    { fastMode: false, value: 'false' },
    { fastMode: true, value: 'true' },
  ])('uses snapshot Fast=$fastMode in create and send', async ({ fastMode, value }) => {
    const createOptions: Array<Omit<AgentOptions, 'apiKey' | 'tools' | 'disallowedTools'>> = []
    const sendOptions: unknown[] = []
    const textUpdates: SubagentTextUpdate[] = []
    const resolveModelSelection = vi.fn(
      async (_modelId: string, requestedFastMode?: boolean, _force?: boolean, effort?: string | null) => ({
        modelId: 'composer-2.5',
        params: [
          { id: 'fast', value: requestedFastMode ? 'true' : 'false' },
          ...(effort ? [{ id: 'reasoning_effort', value: effort }] : []),
        ],
        note: requestedFastMode ? 'fast' : 'standard',
      })
    )
    const agent = {
      agentId: 'cursor-child-1',
      close: vi.fn(),
      send: vi.fn(async (_message: unknown, options: unknown) => {
        sendOptions.push(options)
        return {
          supports: (operation: string) => operation === 'stream' || operation === 'wait' || operation === 'cancel',
          stream: async function* () {
            yield {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
            } as unknown as SDKMessage
            yield {
              type: 'assistant',
              message: { role: 'assistant', content: [{ type: 'text', text: ', Cursor' }] },
            } as unknown as SDKMessage
            yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 30 } } as unknown as SDKMessage
            yield { type: 'status', status: 'FINISHED' } as unknown as SDKMessage
          },
          wait: vi.fn(async () => ({ id: 'run-1', status: 'finished' })),
          cancel: vi.fn(async () => undefined),
        }
      }),
    }
    const manager = {
      accountId: null,
      assertAccountIdentity: vi.fn(),
      resolveModelSelection,
      createAgent: vi.fn(async (options: Omit<AgentOptions, 'apiKey' | 'tools' | 'disallowedTools'>) => {
        createOptions.push(options)
        return { agent, release: vi.fn(async () => undefined) }
      }),
      deleteAgent: vi.fn(async () => undefined),
    } as unknown as CursorSubscriptionManager

    const result = await runCursorSubagent({
      manager,
      accountIdentity: { fingerprint: 'user:1', epoch: 1 },
      conversationId: 'conv-1',
      cwd: '/tmp/project',
      profile: { ...profile, effective: { ...profile.effective!, fastMode, sentEffort: 'high' } },
      definition,
      signal: new AbortController().signal,
      agentName: 'explore',
      task: 'Inspect the repository.',
      readOnly: true,
      tools: {},
      onTextUpdate: (update) => textUpdates.push(update),
    })

    const selection = {
      id: 'composer-2.5',
      params: [
        { id: 'fast', value },
        { id: 'reasoning_effort', value: 'high' },
      ],
    }
    expect(resolveModelSelection).toHaveBeenCalledWith('composer-2.5', fastMode, false, 'high')
    expect(createOptions[0]).toMatchObject({ model: selection })
    expect(sendOptions[0]).toMatchObject({ model: selection })
    expect(result.text).toBe('Hello, Cursor')
    expect(textUpdates).toEqual([
      { kind: 'append', text: 'Hello' },
      { kind: 'append', text: ', Cursor' },
    ])
    expect(result.runtimeEstimatedCostUsd).toBeUndefined()
  })

  it('offers image generation only to mutable workers with a supplied host tool', async () => {
    const workerDefinition: ChatAgent = {
      ...definition,
      name: 'general-purpose',
      tools: ['bash', 'generate_image', 'use_skill'],
    }
    const hostTools: ToolSet = {
      generate_image: tool({
        description: 'Generate an image.',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: vi.fn(async () => 'generated'),
      }),
      use_skill: tool({
        description: 'Load a project skill.',
        inputSchema: jsonSchema({ type: 'object', properties: {} }),
        execute: vi.fn(async () => 'loaded'),
      }),
    }
    const createAgent = vi.fn(async (_options: Omit<AgentOptions, 'apiKey' | 'tools' | 'disallowedTools'>) => ({
      agent: {
        agentId: 'cursor-child-image',
        close: vi.fn(),
        send: vi.fn(async () => ({
          supports: (operation: string) => operation === 'stream' || operation === 'wait' || operation === 'cancel',
          stream: async function* () {
            yield { type: 'status', status: 'FINISHED' } as unknown as SDKMessage
          },
          wait: vi.fn(async () => ({ id: 'run-image', status: 'finished' })),
          cancel: vi.fn(async () => undefined),
        })),
      },
      release: vi.fn(async () => undefined),
    }))
    const manager = {
      accountId: null,
      assertAccountIdentity: vi.fn(),
      resolveModelSelection: vi.fn(async () => ({ modelId: 'grok-4.5', params: [], note: 'standard' })),
      createAgent,
      deleteAgent: vi.fn(async () => undefined),
    } as unknown as CursorSubscriptionManager

    const run = (tools: ToolSet, readOnly: boolean, allowSkillLoader = false) =>
      runCursorSubagent({
        manager,
        accountIdentity: { fingerprint: 'user:1', epoch: 1 },
        conversationId: `conv-image-${createAgent.mock.calls.length}`,
        cwd: '/tmp/project',
        profile,
        definition: workerDefinition,
        signal: new AbortController().signal,
        agentName: 'general-purpose',
        task: 'Generate an image.',
        readOnly,
        tools,
        allowSkillLoader,
      })

    await run(hostTools, false)
    const exposed = createAgent.mock.calls[0]?.[0] as {
      local?: { customTools?: Record<string, unknown> }
    }
    expect(exposed.local?.customTools?.generate_image).toBeDefined()
    expect(exposed.local?.customTools?.use_skill).toBeUndefined()

    await run({}, false)
    const withoutHost = createAgent.mock.calls[1]?.[0] as {
      local?: { customTools?: Record<string, unknown> }
    }
    expect(withoutHost.local?.customTools?.generate_image).toBeUndefined()

    await run(hostTools, true)
    const readOnly = createAgent.mock.calls[2]?.[0] as {
      local?: { customTools?: Record<string, unknown> }
    }
    expect(readOnly.local?.customTools?.generate_image).toBeUndefined()

    await run(hostTools, false, true)
    const maestro = createAgent.mock.calls[3]?.[0] as {
      local?: { customTools?: Record<string, unknown> }
    }
    expect(maestro.local?.customTools?.use_skill).toBeDefined()
  })
})
