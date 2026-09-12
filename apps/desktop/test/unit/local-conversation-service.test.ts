import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  inspectCwdActivity: vi.fn(),
  tryWithCwdExclusive: vi.fn(),
  getWorkspace: vi.fn(),
  insertConversation: vi.fn(),
  prepareGit: vi.fn(),
  executeGit: vi.fn(),
  isAttachOnly: vi.fn(),
  attachStillCurrent: vi.fn(),
  dropStash: vi.fn(),
  uuid: vi.fn(),
}))
vi.mock('node:crypto', () => ({ randomUUID: h.uuid }))
vi.mock('../../src/main/cwd-activity-coordinator', () => ({
  inspectCwdActivity: h.inspectCwdActivity,
  tryWithCwdExclusive: h.tryWithCwdExclusive,
}))
vi.mock('../../src/main/store', () => ({ getWorkspace: h.getWorkspace, insertConversation: h.insertConversation }))
vi.mock('../../src/main/local-conversation/git', () => ({
  prepareLocalGitOperation: h.prepareGit,
  executePreparedLocalGit: h.executeGit,
  isLocalConversationAttachOnly: h.isAttachOnly,
  isAttachTargetCurrentBranch: h.attachStillCurrent,
  dropOperationStash: h.dropStash,
}))

import {
  __resetLocalConversationTokensForTests,
  confirmLocalConversation,
  prepareLocalConversation,
} from '../../src/main/local-conversation/service'

const preview = {
  currentBranch: 'main',
  headOid: 'a',
  targetBranch: 'other',
  targetOid: 'b',
  targetLabel: 'other',
  strategy: 'stash-switch-apply' as const,
  changes: { staged: [], unstaged: ['x'], untracked: [] },
  ignoredCollisions: [],
  blockers: [],
  activity: [],
  dirty: true,
  requiresConfirmation: true,
}
const gitOp = {
  cwd: '/repo',
  intent: { type: 'switch-existing', branch: 'other', ref: { kind: 'local', name: 'other' } },
  currentBranch: 'main',
  headOid: 'a',
  target: { branch: 'other', oid: 'b', label: 'other', switchArgs: [], createsBranch: false },
  strategy: 'stash-switch-apply',
  status: {},
  ignoredCollisions: [],
  blockers: [],
  activity: [],
  fingerprint: 'fp',
  preview,
}
const input = { workspaceId: 'ws', cli: 'chat' as const, intent: gitOp.intent as never }

beforeEach(() => {
  vi.clearAllMocks()
  __resetLocalConversationTokensForTests()
  let n = 0
  h.uuid.mockImplementation(() => `uuid-${++n}`)
  h.getWorkspace.mockReturnValue({ id: 'ws', path: '/repo' })
  h.inspectCwdActivity.mockReturnValue([])
  h.prepareGit.mockResolvedValue(gitOp)
  h.tryWithCwdExclusive.mockImplementation(async (_cwd: string, fn: () => unknown) => ({ ok: true, value: await fn() }))
  h.executeGit.mockResolvedValue({ status: 'applied', stashOid: 'stash-oid', marker: 'marker' })
  h.isAttachOnly.mockReturnValue(false)
  h.attachStillCurrent.mockResolvedValue(true)
  h.dropStash.mockResolvedValue(true)
})

describe('local conversation service', () => {
  it('orders apply → insert → drop and returns created', async () => {
    const prepared = await prepareLocalConversation(input)
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    const result = await confirmLocalConversation(prepared.token)
    expect(result.status).toBe('created')
    expect(h.executeGit.mock.invocationCallOrder[0]).toBeLessThan(h.insertConversation.mock.invocationCallOrder[0])
    expect(h.insertConversation.mock.invocationCallOrder[0]).toBeLessThan(h.dropStash.mock.invocationCallOrder[0])
  })

  it('an expired token has no effect', async () => {
    vi.useFakeTimers()
    try {
      const prepared = await prepareLocalConversation(input)
      if (prepared.status !== 'ready') throw new Error('prepare failed')
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1)
      expect((await confirmLocalConversation(prepared.token)).status).toBe('expired-token')
      expect(h.executeGit).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tokens are single-use and stale refreshes the preview without running Git', async () => {
    const prepared = await prepareLocalConversation(input)
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    h.prepareGit
      .mockResolvedValueOnce({ ...gitOp, fingerprint: 'changed' })
      .mockResolvedValueOnce({ ...gitOp, fingerprint: 'changed' })
    const stale = await confirmLocalConversation(prepared.token)
    expect(stale.status).toBe('stale')
    expect(h.executeGit).not.toHaveBeenCalled()
    expect((await confirmLocalConversation(prepared.token)).status).toBe('invalid-token')
  })

  it('conflicts, partial apply, and insert failures preserve the stash without dropping it', async () => {
    const first = await prepareLocalConversation(input)
    if (first.status !== 'ready') throw new Error('prepare failed')
    h.executeGit.mockResolvedValueOnce({
      status: 'recovery-required',
      recovery: { currentBranch: 'other', headOid: 'b', status: [], commands: [], message: 'conflict' },
    })
    expect((await confirmLocalConversation(first.token)).status).toBe('recovery-required')
    expect(h.insertConversation).not.toHaveBeenCalled()
    expect(h.dropStash).not.toHaveBeenCalled()

    const second = await prepareLocalConversation(input)
    if (second.status !== 'ready') throw new Error('prepare failed')
    h.executeGit.mockResolvedValueOnce({ status: 'applied', stashOid: 'stash-oid', marker: 'marker' })
    h.insertConversation.mockImplementationOnce(() => {
      throw new Error('db down')
    })
    expect((await confirmLocalConversation(second.token)).status).toBe('recovery-required')
    expect(h.dropStash).not.toHaveBeenCalled()
  })

  it('an isolated drop failure retains the created conversation and reports the OID', async () => {
    const prepared = await prepareLocalConversation(input)
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    h.dropStash.mockRejectedValueOnce(new Error('drop failed'))
    const result = await confirmLocalConversation(prepared.token)
    expect(result).toMatchObject({ status: 'created', stashOid: 'stash-oid' })
    expect(result.status === 'created' && result.warning).toContain('drop failed')
  })

  it('a drop rejected by a concurrent stash retains the conversation and returns a warning', async () => {
    const prepared = await prepareLocalConversation(input)
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    h.dropStash.mockResolvedValueOnce(false)
    const result = await confirmLocalConversation(prepared.token)
    expect(result).toMatchObject({ status: 'created', stashOid: 'stash-oid' })
    expect(result.status === 'created' && result.warning).toContain('preserved')
  })

  it('stale execution renews the token without inserting a conversation', async () => {
    const prepared = await prepareLocalConversation(input)
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    h.executeGit.mockResolvedValueOnce({ status: 'stale', current: gitOp })
    const result = await confirmLocalConversation(prepared.token)
    expect(result.status).toBe('stale')
    expect(h.insertConversation).not.toHaveBeenCalled()
    expect(h.dropStash).not.toHaveBeenCalled()
  })

  it('blocked execution and concurrent deletion do not insert a conversation', async () => {
    const blockedGit = {
      ...gitOp,
      blockers: [{ code: 'activity', message: 'busy' }],
      preview: { ...preview, blockers: [{ code: 'activity', message: 'busy' }] },
    }
    const first = await prepareLocalConversation(input)
    if (first.status !== 'ready') throw new Error('prepare failed')
    h.executeGit.mockResolvedValueOnce({ status: 'blocked', current: blockedGit })
    expect(await confirmLocalConversation(first.token)).toMatchObject({ status: 'blocked' })

    const second = await prepareLocalConversation(input)
    if (second.status !== 'ready') throw new Error('prepare failed')
    h.tryWithCwdExclusive.mockResolvedValueOnce({
      ok: false,
      reason: 'exclusive',
      activity: [],
    })
    h.prepareGit.mockResolvedValueOnce(gitOp)
    const exclusive = await confirmLocalConversation(second.token)
    expect(exclusive).toMatchObject({
      status: 'blocked',
      blockers: [expect.objectContaining({ code: 'activity' })],
    })
    expect(h.insertConversation).not.toHaveBeenCalled()
    expect(h.dropStash).not.toHaveBeenCalled()
  })

  it('attaching on the current branch creates with cwd activity without recheck or Git execution', async () => {
    const attachPreview = {
      ...preview,
      currentBranch: 'main',
      targetBranch: 'main',
      targetOid: 'a',
      targetLabel: 'main',
      strategy: 'switch-direct' as const,
      activity: [{ kind: 'chat' as const, count: 1, blocking: true }],
      requiresConfirmation: false,
    }
    const attachOp = {
      ...gitOp,
      intent: {
        type: 'switch-existing' as const,
        branch: 'main',
        ref: { kind: 'local' as const, name: 'main' },
      },
      target: {
        branch: 'main',
        oid: 'a',
        label: 'main',
        switchArgs: null,
        postSwitchArgs: [],
        createsBranch: false,
      },
      strategy: 'switch-direct' as const,
      activity: attachPreview.activity,
      preview: attachPreview,
    }
    h.inspectCwdActivity.mockReturnValue(attachPreview.activity)
    h.prepareGit.mockResolvedValue(attachOp)
    h.isAttachOnly.mockReturnValue(true)

    const prepared = await prepareLocalConversation({
      ...input,
      intent: attachOp.intent,
    })
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    const result = await confirmLocalConversation(prepared.token)

    expect(result.status).toBe('created')
    expect(h.tryWithCwdExclusive).toHaveBeenCalledWith('/repo', expect.any(Function), { allowActivity: true })
    expect(h.prepareGit).toHaveBeenCalledTimes(1)
    expect(h.executeGit).not.toHaveBeenCalled()
    expect(h.insertConversation).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'local', cwd: '/repo', branch: 'main' })
    )
  })

  it('attach becomes stale if checkout leaves the target branch between preview and confirmation', async () => {
    const attachOp = {
      ...gitOp,
      intent: {
        type: 'switch-existing' as const,
        branch: 'main',
        ref: { kind: 'local' as const, name: 'main' },
      },
      target: {
        branch: 'main',
        oid: 'a',
        label: 'main',
        switchArgs: null,
        postSwitchArgs: [],
        createsBranch: false,
      },
      preview: { ...preview, currentBranch: 'main', targetBranch: 'main', targetOid: 'a' },
    }
    h.prepareGit.mockResolvedValue(attachOp)
    h.isAttachOnly.mockReturnValue(true)
    h.attachStillCurrent.mockResolvedValueOnce(false)

    const prepared = await prepareLocalConversation({ ...input, intent: attachOp.intent })
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    const result = await confirmLocalConversation(prepared.token)

    expect(result.status).toBe('stale')
    expect(h.insertConversation).not.toHaveBeenCalled()
    expect(h.executeGit).not.toHaveBeenCalled()
    // Re-preparing issued a new token, so the flow can be confirmed again.
    if (result.status !== 'stale') throw new Error('stale ausente')
    expect(result.token).not.toBe(prepared.token)
  })

  it('attaching on the current branch still blocks when an exclusive transition exists', async () => {
    const attachOp = {
      ...gitOp,
      intent: {
        type: 'switch-existing' as const,
        branch: 'main',
        ref: { kind: 'local' as const, name: 'main' },
      },
      target: {
        branch: 'main',
        oid: 'a',
        label: 'main',
        switchArgs: null,
        postSwitchArgs: [],
        createsBranch: false,
      },
      preview: {
        ...preview,
        currentBranch: 'main',
        targetBranch: 'main',
        targetOid: 'a',
        blockers: [],
        requiresConfirmation: false,
      },
    }
    h.prepareGit.mockResolvedValue(attachOp)
    h.isAttachOnly.mockReturnValue(true)
    h.tryWithCwdExclusive.mockResolvedValueOnce({
      ok: false,
      reason: 'exclusive',
      activity: [],
    })

    const prepared = await prepareLocalConversation({ ...input, intent: attachOp.intent })
    if (prepared.status !== 'ready') throw new Error('prepare failed')
    const result = await confirmLocalConversation(prepared.token)

    expect(result).toMatchObject({
      status: 'blocked',
      blockers: [expect.objectContaining({ code: 'activity' })],
    })
    expect(h.insertConversation).not.toHaveBeenCalled()
    expect(h.executeGit).not.toHaveBeenCalled()
  })
})
