import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionBroker } from '../../src/main/chat/permission'
import { QuestionBroker } from '../../src/main/chat/question-broker'
import { executeSubagent } from '../../src/main/chat/subagent-executor'

const h = vi.hoisted(() => ({
  runAntigravity: vi.fn(),
  runByok: vi.fn(),
  getManager: vi.fn(),
  assertIdentity: vi.fn(),
  identity: vi.fn(),
  status: vi.fn(),
}))
vi.mock('../../src/main/chat/antigravity-subscription/subagent-runner', () => ({
  runAntigravitySubagent: h.runAntigravity,
}))
vi.mock('../../src/main/chat/antigravity-subscription/manager', () => ({
  getAntigravitySubscriptionManager: h.getManager,
}))
vi.mock('../../src/main/chat/subagent-runner', () => ({ runSubagent: h.runByok }))
vi.mock('../../src/main/chat/tools', () => ({
  ALL_TOOL_NAMES: [],
  buildTools: () => ({}),
  selectSubagentToolNames: () => new Set(),
}))
vi.mock('../../src/main/chat/subagent-ownership', () => ({
  withSubagentMessageOwnership: (input: { execute: () => Promise<unknown> }) => input.execute(),
}))

import { subagentProviderStatus } from '../../src/main/chat/subagent-provider-runtime'

function args(
  providerId: string,
  parentProviderId = 'builtin_codex_subscription'
): Parameters<typeof executeSubagent>[0] {
  return {
    conversationId: 'conversation',
    projectId: 'project',
    cwd: '/tmp/project',
    parentMessageId: 'message',
    mode: 'agent',
    permMode: 'ask',
    agentName: 'general-purpose',
    task: 'Review the change.',
    readOnly: true,
    definition: { name: 'general-purpose', description: 'Worker', prompt: 'Do the task.', source: 'test' },
    profile: {
      version: 1,
      agentName: 'general-purpose',
      attempts: [],
      effective: {
        providerId,
        modelId: 'gemini-3.1-pro',
        configuredEffort: 'high',
        sentEffort: 'high',
        source: 'conversation-default',
        candidateIndex: 0,
      },
    },
    broker: new PermissionBroker({ rulesetFor: () => [] }),
    questionBroker: new QuestionBroker(),
    signal: new AbortController().signal,
    account: { parentProviderId },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.identity.mockReturnValue({ fingerprint: 'project:worker', epoch: 3 })
  h.status.mockReturnValue({ state: 'signed-in', authenticated: true })
  h.getManager.mockReturnValue({
    getAccountIdentity: h.identity,
    assertAccountIdentity: h.assertIdentity,
    getStatus: h.status,
  })
  h.runAntigravity.mockResolvedValue({ text: 'Gemini report' })
})

describe('Antigravity subagent provider boundary', () => {
  it('runs a Google AI child with its own account instead of the BYOK runner', async () => {
    const input = args('builtin_antigravity_subscription@acc_work')
    await expect(executeSubagent(input)).resolves.toEqual({ text: 'Gemini report' })
    expect(h.getManager).toHaveBeenCalledWith('acc_work')
    expect(h.runAntigravity).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: input.profile,
        task: input.task,
        readOnly: true,
        accountIdentity: { fingerprint: 'project:worker', epoch: 3 },
      })
    )
    expect(h.assertIdentity).toHaveBeenCalledTimes(2)
    expect(h.runByok).not.toHaveBeenCalled()
  })

  it('refuses a signed-out Google AI child', async () => {
    h.identity.mockReturnValue({ fingerprint: null, epoch: 0 })
    await expect(executeSubagent(args('builtin_antigravity_subscription'))).resolves.toMatchObject({
      errorCode: 'agent-unavailable',
    })
    expect(h.runAntigravity).not.toHaveBeenCalled()
  })

  it('reports provider availability from the account sign-in', async () => {
    h.status.mockReturnValue({ state: 'signed-in', authenticated: true })
    await expect(subagentProviderStatus('builtin_antigravity_subscription')).resolves.toBe('available')
    h.status.mockReturnValue({ state: 'signed-out', authenticated: false })
    await expect(subagentProviderStatus('builtin_antigravity_subscription')).resolves.toBe('disconnected')
  })
})
