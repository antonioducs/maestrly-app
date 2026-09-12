import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class WorkflowPermissionBroker {
    rulesetFor: () => unknown

    constructor({ rulesetFor }: { rulesetFor: () => unknown }) {
      this.rulesetFor = rulesetFor
    }
  }

  return {
    WorkflowPermissionBroker,
    yoloRuleset: [{ action: '*', resource: '*', effect: 'allow' }],
    getConversation: vi.fn(),
    getConvUiPrefs: vi.fn(),
    getReviewData: vi.fn(),
    executeSubagent: vi.fn(),
    getChatQuestionBroker: vi.fn(() => ({})),
    subagentProviderStatus: vi.fn(async () => 'available'),
    subagentModelCatalog: vi.fn(async () => ({ status: 'available', models: ['model'] })),
    getSubagentProfileModelMeta: vi.fn(async () => ({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['low', 'high', 'ultra'] },
    })),
    isWorkingTreeClean: vi.fn(),
    isMergeInProgress: vi.fn(),
    hasUnmergedFiles: vi.fn(),
    hasConflictMarkers: vi.fn(),
    isBranchPushed: vi.fn(),
  }
})

vi.mock('../../src/main/store', () => ({
  getConversation: h.getConversation,
  getConvUiPrefs: h.getConvUiPrefs,
}))
vi.mock('../../src/main/gh-service', () => ({ getReviewData: h.getReviewData }))
vi.mock('../../src/main/chat/subagent-executor', () => ({ executeSubagent: h.executeSubagent }))
vi.mock('../../src/main/chat/agents', () => ({
  BUILTIN_AGENTS: [
    {
      name: 'general-purpose',
      category: 'implementation',
      description: 'test worker',
      prompt: 'test worker',
      source: 'built-in',
    },
  ],
}))
vi.mock('../../src/main/chat/service', () => ({ getChatQuestionBroker: h.getChatQuestionBroker }))
vi.mock('../../src/main/chat/subagent-provider-runtime', () => ({
  subagentProviderStatus: h.subagentProviderStatus,
  subagentModelCatalog: h.subagentModelCatalog,
}))
vi.mock('../../src/main/chat/subagent-profile-model-meta', () => ({
  getSubagentProfileModelMeta: h.getSubagentProfileModelMeta,
}))
vi.mock('../../src/main/chat/permission', () => ({
  PermissionBroker: h.WorkflowPermissionBroker,
  YOLO_RULESET: h.yoloRuleset,
}))
vi.mock('../../src/main/git-service', () => ({
  isWorkingTreeClean: h.isWorkingTreeClean,
  isMergeInProgress: h.isMergeInProgress,
  hasUnmergedFiles: h.hasUnmergedFiles,
  hasConflictMarkers: h.hasConflictMarkers,
  isBranchPushed: h.isBranchPushed,
}))

import { resolveReviewConflicts } from '../../src/main/conflict-resolver'
import { __resetCwdActivityForTests, tryAcquireCwdActivity } from '../../src/main/cwd-activity-coordinator'
import { MAESTRLY_ULTRA_EFFORT } from '../../src/shared/chat'

const cwd = '/tmp/review-conflict-resolver'

beforeEach(() => {
  vi.clearAllMocks()
  h.getConversation.mockReturnValue({
    id: 'conv-1',
    cwd,
    workspaceId: 'workspace-1',
    branch: 'feature',
    isMulti: false,
  })
  h.getConvUiPrefs.mockReturnValue({
    chat: { providerId: 'provider', modelId: 'model', permMode: 'ask' },
  })
  h.getReviewData.mockResolvedValue({
    repos: [{ branch: 'feature', pr: { mergeable: 'CONFLICTING', baseRef: 'main' } }],
  })
  h.isWorkingTreeClean.mockResolvedValue(true)
  h.isMergeInProgress.mockResolvedValue(false)
  h.hasUnmergedFiles.mockResolvedValue(false)
  h.hasConflictMarkers.mockResolvedValue(false)
  h.isBranchPushed.mockResolvedValue(true)
  h.executeSubagent.mockResolvedValue({ text: 'resolved' })
  h.subagentProviderStatus.mockResolvedValue('available')
  h.subagentModelCatalog.mockResolvedValue({ status: 'available', models: ['model'] })
  h.getSubagentProfileModelMeta.mockResolvedValue({
    status: 'available',
    meta: { reasoning: true, reasoningEfforts: ['low', 'high', 'ultra'] },
  })
})

afterEach(() => {
  __resetCwdActivityForTests()
})

describe('resolveReviewConflicts cwd boundary', () => {
  it('blocks a competing cwd owner before starting the worker', async () => {
    const competing = tryAcquireCwdActivity(cwd, 'chat')

    await expect(resolveReviewConflicts('conv-1')).resolves.toMatchObject({
      ok: false,
      status: 'cwd-locked',
    })
    expect(h.executeSubagent).not.toHaveBeenCalled()

    competing?.()
  })

  it('keeps the cwd exclusive through post-verification and releases it on success', async () => {
    h.hasUnmergedFiles.mockImplementation(async () => {
      expect(tryAcquireCwdActivity(cwd, 'terminal')).toBeNull()
      return false
    })

    await expect(resolveReviewConflicts('conv-1')).resolves.toMatchObject({ ok: true, status: 'resolved' })

    const after = tryAcquireCwdActivity(cwd, 'terminal')
    expect(after).toBeTypeOf('function')
    after?.()
  })

  it('releases the cwd on worker failure', async () => {
    h.executeSubagent.mockRejectedValue(new Error('worker failed'))

    await expect(resolveReviewConflicts('conv-1')).resolves.toMatchObject({
      ok: false,
      status: 'agent-failed',
    })

    const after = tryAcquireCwdActivity(cwd, 'chat')
    expect(after).toBeTypeOf('function')
    after?.()
  })

  it('does not inherit ask-mode for this unmounted Review workflow', async () => {
    await resolveReviewConflicts('conv-1')

    const args = h.executeSubagent.mock.calls[0]?.[0]
    expect(args.permMode).toBe('full')
    expect(args.parentMessageOwnership).toEqual({ kind: 'host-managed', cleanup: 'delete' })
    expect(args.broker).toBeInstanceOf(h.WorkflowPermissionBroker)
    expect(args.broker.rulesetFor()).toBe(h.yoloRuleset)
  })

  it('passes the validated parent profile, translating synthetic Ultra and preserving native Ultra', async () => {
    h.getSubagentProfileModelMeta.mockResolvedValueOnce({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['low', 'high'] },
    })
    await resolveReviewConflicts('conv-1', { reasoning: MAESTRLY_ULTRA_EFFORT })
    expect(h.executeSubagent.mock.calls[0]?.[0].profile.effective).toMatchObject({
      source: 'parent',
      configuredEffort: MAESTRLY_ULTRA_EFFORT,
      sentEffort: 'high',
    })

    h.executeSubagent.mockClear()
    h.getSubagentProfileModelMeta.mockResolvedValueOnce({
      status: 'available',
      meta: { reasoning: true, reasoningEfforts: ['low', 'ultra'] },
    })
    await resolveReviewConflicts('conv-1', { reasoning: 'ultra' })
    expect(h.executeSubagent.mock.calls[0]?.[0].profile.effective.sentEffort).toBe('ultra')
  })

  it('passes off as no effort and refuses disconnected or unavailable parent selections', async () => {
    await resolveReviewConflicts('conv-1', { reasoning: 'off' })
    expect(h.executeSubagent.mock.calls[0]?.[0].profile.effective.sentEffort).toBeNull()

    h.executeSubagent.mockClear()
    h.subagentProviderStatus.mockResolvedValueOnce('disconnected')
    await expect(resolveReviewConflicts('conv-1')).resolves.toMatchObject({
      ok: false,
      status: 'agent-unavailable',
    })
    expect(h.executeSubagent).not.toHaveBeenCalled()

    h.subagentProviderStatus.mockResolvedValue('available')
    h.subagentModelCatalog.mockResolvedValueOnce({ status: 'available', models: [] })
    await expect(
      resolveReviewConflicts('conv-1', { providerId: 'builtin_claude_subscription', modelId: 'fable' })
    ).resolves.toMatchObject({
      ok: false,
      status: 'agent-unavailable',
    })
    expect(h.executeSubagent).not.toHaveBeenCalled()
  })
})
