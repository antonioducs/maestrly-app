import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubagentExecutionSnapshotV1 } from '../../src/shared/subagent-profiles'
import { closeDb, freshDb } from '../helpers/db'

const h = vi.hoisted(() => ({
  runSubagent: vi.fn(),
  validate: vi.fn(),
  config: null as unknown,
}))

vi.mock('../../src/main/chat/subagent-runner', () => ({
  namespaceSubagentToolCallId: (taskCallId: string, toolCallId: string) => `${taskCallId}:${toolCallId}`,
  namespaceSubagentToolSet: (tools: unknown) => tools,
  runSubagent: h.runSubagent,
  subagentPermissionAssertInput: (input: unknown) => input,
}))
vi.mock('../../src/main/chat/subagent-ownership', () => ({
  withSubagentMessageOwnership: ({ execute }: { execute: () => Promise<unknown> }) => execute(),
}))
vi.mock('../../src/main/chat/subagent-profile-resolver', () => ({
  validateSubagentProfileCandidate: h.validate,
}))
vi.mock('../../src/main/chat/model-fallback/config', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/model-fallback/config')>()),
  getModelFallbackConfig: () => h.config,
}))
vi.mock('../../src/main/chat/catalog', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/catalog')>()),
  getProvider: (id: string) => ({ id, name: id, baseURL: 'https://example.test/v1' }),
}))
vi.mock('../../src/main/chat/credentials', async (original) => ({
  ...(await original<typeof import('../../src/main/chat/credentials')>()),
  hasApiKey: () => true,
}))
vi.mock('../../src/main/chat/subscription-failover/ephemeral', () => ({ emitSubscriptionFailoverEvent: vi.fn() }))

import { resetStickyWinnersForTests } from '../../src/main/chat/model-fallback/sticky'
import { executeSubagent } from '../../src/main/chat/subagent-executor'
import { getSubscriptionFailoverRouter } from '../../src/main/chat/subscription-failover/router'

type RunArgs = {
  profile: SubagentExecutionSnapshotV1
  task: string
  onTerminalFailure?: (error: unknown) => void
  shouldRetryInPlace?: (error: unknown) => boolean
}

const quota = () => Object.assign(new Error('You exceeded your current quota'), { statusCode: 429 })
const usage = (n: number) => ({ input: n, output: n, cacheRead: 0, cacheCreate: 0, totalInput: n })

function profile(source: 'parent' | 'bot-delegation' = 'parent'): SubagentExecutionSnapshotV1 {
  return {
    version: 1,
    agentName: 'general-purpose',
    effective: {
      providerId: 'primary',
      modelId: 'big',
      configuredEffort: 'max',
      sentEffort: 'max',
      source,
      candidateIndex: 0,
    },
    attempts: [],
  }
}

const run = (snapshot = profile()) =>
  executeSubagent({
    conversationId: 'conv-subagent-fallback',
    projectId: null,
    cwd: '/tmp/subagent-fallback',
    parentMessageId: 'parent-message',
    parentMessageOwnership: { kind: 'standalone' },
    mode: 'agent',
    permMode: 'full',
    profile: snapshot,
    definition: { name: 'general-purpose', description: 'worker', prompt: 'worker', source: 'built-in' },
    agentName: 'general-purpose',
    task: 'fix the flaky test',
    readOnly: true,
    broker: {} as never,
    questionBroker: {} as never,
    signal: new AbortController().signal,
  })

const calls = () => h.runSubagent.mock.calls.map(([args]) => args as RunArgs)

describe('subagent model fallback', () => {
  beforeEach(() => {
    freshDb()
    h.runSubagent.mockReset()
    h.validate.mockReset()
    h.validate.mockResolvedValue({ valid: true, sentEffort: 'high', diagnostics: [] })
    h.config = { version: 1, enabled: true, fallbacks: [{ providerId: 'other', modelId: 'small', reasoning: 'high' }] }
  })
  afterEach(() => {
    closeDb()
    getSubscriptionFailoverRouter().reset()
    resetStickyWinnersForTests()
  })

  it('continues the task on the fallback with its own profile, and sums the usage', async () => {
    h.runSubagent
      .mockImplementationOnce(async (args: RunArgs) => {
        expect(args.shouldRetryInPlace?.(quota())).toBe(false)
        args.onTerminalFailure?.(quota())
        return { text: '', error: 'quota exceeded', usage: usage(3) }
      })
      .mockImplementationOnce(async () => ({
        text: 'fixed',
        usage: usage(5),
        model: { providerId: 'other', modelId: 'small' },
      }))

    const result = await run()

    expect(result).toMatchObject({ text: 'fixed', usage: usage(8) })
    expect(calls().map((args) => args.profile.effective?.modelId)).toEqual(['big', 'small'])
    expect(calls()[1].profile.effective).toMatchObject({
      providerId: 'other',
      modelId: 'small',
      configuredEffort: 'high',
      sentEffort: 'high',
    })
    expect(calls()[1].task).toContain('fix the flaky test')
    expect(calls()[1].task).toContain('model fallback continuation')
  })

  it('returns the failure as before when nothing else can run', async () => {
    h.config = { version: 1, enabled: false, fallbacks: [] }
    h.runSubagent.mockImplementationOnce(async (args: RunArgs) => {
      expect(args.shouldRetryInPlace?.(quota())).toBe(true)
      args.onTerminalFailure?.(quota())
      return { text: '', error: 'quota exceeded', usage: usage(3) }
    })

    await expect(run()).resolves.toMatchObject({ text: '', error: 'quota exceeded', usage: usage(3) })
    expect(calls()).toHaveLength(1)
  })

  it('keeps a routed bot delegation on its model', async () => {
    h.runSubagent.mockImplementationOnce(async (args: RunArgs) => {
      args.onTerminalFailure?.(quota())
      return { text: '', error: 'quota exceeded' }
    })

    await expect(run(profile('bot-delegation'))).resolves.toMatchObject({ error: 'quota exceeded' })
    expect(calls()).toHaveLength(1)
  })

  it('skips a fallback that cannot run subagents and reports the real failure', async () => {
    h.validate.mockResolvedValue({ valid: false, sentEffort: null, diagnostics: [] })
    h.runSubagent.mockImplementationOnce(async (args: RunArgs) => {
      args.onTerminalFailure?.(quota())
      return { text: '', error: 'quota exceeded' }
    })

    await expect(run()).resolves.toMatchObject({ error: 'quota exceeded' })
    expect(calls()).toHaveLength(1)
  })

  it('does not fall back on a failure another model cannot fix', async () => {
    h.runSubagent.mockImplementationOnce(async (args: RunArgs) => {
      args.onTerminalFailure?.(Object.assign(new Error('content_policy_violation'), { statusCode: 400 }))
      return { text: '', error: 'rejected' }
    })

    await expect(run()).resolves.toMatchObject({ error: 'rejected' })
    expect(calls()).toHaveLength(1)
  })
})
