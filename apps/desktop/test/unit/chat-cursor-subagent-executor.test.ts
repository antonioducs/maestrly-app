import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeSubagent } from '../../src/main/chat/subagent-executor'
import { PermissionBroker } from '../../src/main/chat/permission'
import { QuestionBroker } from '../../src/main/chat/question-broker'

const h = vi.hoisted(() => ({
  runCursor: vi.fn(),
  runByok: vi.fn(),
  getManager: vi.fn(),
  status: vi.fn(),
  assertIdentity: vi.fn(),
}))
vi.mock('../../src/main/chat/cursor-subscription/subagent-runner', () => ({ runCursorSubagent: h.runCursor }))
vi.mock('../../src/main/chat/cursor-subscription/manager', () => ({ getCursorSubscriptionManager: h.getManager }))
vi.mock('../../src/main/chat/subagent-runner', () => ({ runSubagent: h.runByok }))
vi.mock('../../src/main/chat/tools', () => ({
  ALL_TOOL_NAMES: [],
  buildTools: () => ({}),
  selectSubagentToolNames: () => new Set(),
}))
vi.mock('../../src/main/chat/subagent-ownership', () => ({
  withSubagentMessageOwnership: (input: { execute: () => Promise<unknown> }) => input.execute(),
}))

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
        modelId: 'worker-model',
        configuredEffort: 'high',
        sentEffort: 'high',
        fastMode: true,
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
  h.assertIdentity.mockReset()
  h.status.mockResolvedValue({ available: true, authenticated: true, accountFingerprint: 'worker', accountEpoch: 7 })
  h.getManager.mockReturnValue({ getStatus: h.status, assertAccountIdentity: h.assertIdentity })
  h.runCursor.mockResolvedValue({ text: 'Cursor report', usage: { input: 10, output: 4 } })
  h.runByok.mockResolvedValue({ text: 'BYOK report' })
})

describe('Cursor subagent provider boundary', () => {
  it('runs a Cursor child of a Codex parent with its own account and forwards SDK usage', async () => {
    const input = args('builtin_cursor_subscription@work')
    await expect(executeSubagent(input)).resolves.toEqual({ text: 'Cursor report', usage: { input: 10, output: 4 } })
    expect(h.getManager).toHaveBeenCalledWith('work')
    expect(h.runCursor).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: input.profile,
        task: input.task,
        readOnly: true,
        accountIdentity: { fingerprint: 'worker', epoch: 7 },
      })
    )
    expect(h.assertIdentity).toHaveBeenCalledTimes(2)
    expect(h.runByok).not.toHaveBeenCalled()
  })

  it('runs a BYOK child of a Cursor parent through the selected child provider', async () => {
    await expect(executeSubagent(args('openai', 'builtin_cursor_subscription'))).resolves.toEqual({
      text: 'BYOK report',
    })
    expect(h.runByok).toHaveBeenCalledOnce()
    expect(h.runCursor).not.toHaveBeenCalled()
  })

  it('does not start an unauthenticated Cursor child or fall back to another provider', async () => {
    h.status.mockResolvedValue({ available: true, authenticated: false })
    await expect(executeSubagent(args('builtin_cursor_subscription@work'))).resolves.toMatchObject({
      errorCode: 'agent-unavailable',
    })
    expect(h.runCursor).not.toHaveBeenCalled()
    expect(h.runByok).not.toHaveBeenCalled()
  })

  it('rejects output when the child account changes during execution', async () => {
    h.assertIdentity
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Account changed')
      })
    await expect(executeSubagent(args('builtin_cursor_subscription'))).rejects.toThrow('Account changed')
    expect(h.runByok).not.toHaveBeenCalled()
  })
})
