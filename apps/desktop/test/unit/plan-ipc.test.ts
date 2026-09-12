import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestRegistrar } from './ipc-registrar-test-utils'

const h = vi.hoisted(() => ({
  decidePlan: vi.fn(),
  commitPlanDecision: vi.fn(),
  getConversation: vi.fn(),
  runApprovedPlan: vi.fn(),
  runPlanRevision: vi.fn(),
  setChatMode: vi.fn(),
  createMaestroSibling: vi.fn(),
  deleteConversation: vi.fn(),
  isConversationReserved: vi.fn(),
  applyMaestroStrategyProfile: vi.fn(),
  markMaestroStrategyProfileUsed: vi.fn(),
  excludeFromGitInfo: vi.fn(),
  focusFloatIfAny: vi.fn(),
}))

vi.mock('../../src/main/floating-manager', () => ({
  focusFloatIfAny: h.focusFloatIfAny,
}))

vi.mock('../../src/main/git-service', () => ({
  excludeFromGitInfo: h.excludeFromGitInfo,
}))

vi.mock('../../src/main/plan-broker', () => ({
  decidePlan: h.decidePlan,
  commitPlanDecision: h.commitPlanDecision,
  getPending: vi.fn(),
}))

vi.mock('../../src/main/platform', () => ({
  toForwardSlashes: vi.fn((value: string) => value.replace(/\\/g, '/')),
}))

vi.mock('../../src/main/store', () => ({
  getConversation: h.getConversation,
}))

vi.mock('../../src/main/chat/service', () => ({
  runApprovedPlan: h.runApprovedPlan,
  runPlanRevision: h.runPlanRevision,
  setChatMode: h.setChatMode,
}))

import { registerPlanIpc } from '../../src/main/plan-ipc'

let tempRoots: string[] = []

describe('registerPlanIpc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.decidePlan.mockReset()
    h.commitPlanDecision.mockReset()
    h.commitPlanDecision.mockReturnValue(true)
    h.getConversation.mockReset()
    h.runApprovedPlan.mockReset()
    h.runPlanRevision.mockReset()
    h.setChatMode.mockReset()
    h.createMaestroSibling.mockReset()
    h.deleteConversation.mockReset()
    h.deleteConversation.mockResolvedValue(undefined)
    h.isConversationReserved.mockReset()
    h.isConversationReserved.mockReturnValue(false)
    h.applyMaestroStrategyProfile.mockReset()
    h.applyMaestroStrategyProfile.mockResolvedValue({ ok: true })
    h.markMaestroStrategyProfileUsed.mockReset()
    h.excludeFromGitInfo.mockReset()
    h.focusFloatIfAny.mockReset()
    h.focusFloatIfAny.mockReturnValue(false)
  })

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })))
    tempRoots = []
  })

  it('registers plan:get with handle and plan:decide/open-file with mhandle', () => {
    const { reg, handles, mhandles, ons, mons } = createTestRegistrar()

    registerPlanIpc(reg, { sendToWindow: vi.fn() })

    expect([...handles.keys()]).toEqual(['plan:get'])
    expect([...mhandles.keys()].sort()).toEqual(['plan:decide', 'plan:open-file'])
    expect(ons.size).toBe(0)
    expect(mons.size).toBe(0)
  })

  it('approve (chat) sets Agent mode, notifies the UI, and starts implementation with the final plan', () => {
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.decidePlan.mockReturnValue({ action: 'approve', approvedPlan: '## Edited' })
    registerPlanIpc(reg, { sendToWindow })

    mhandles.get('plan:decide')?.({} as never, 'conv-chat', { action: 'approve', editedPlan: '## Edited' })

    expect(h.setChatMode).toHaveBeenCalledWith('conv-chat', 'agent')
    expect(sendToWindow).toHaveBeenCalledWith('chat:mode:conv-chat', 'agent')
    expect(h.runApprovedPlan).toHaveBeenCalledWith('conv-chat', '## Edited')
    expect(h.runPlanRevision).not.toHaveBeenCalled()
  })

  it('Maestro approval creates a sibling, preserves Standard, and runs only in the new conversation', async () => {
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    const source = {
      id: 'conv-standard',
      name: 'Checkout',
      experience: 'standard',
      branch: 'feat/checkout',
      cwd: '/worktrees/checkout',
    }
    const maestro = {
      ...source,
      id: 'conv-maestro',
      name: 'Checkout · Maestro',
      experience: 'maestro',
    }
    h.getConversation.mockReturnValue(source)
    h.decidePlan.mockReturnValue({ action: 'approve', approvedPlan: '## Edited plan' })
    h.createMaestroSibling.mockResolvedValue(maestro)
    registerPlanIpc(reg, {
      sendToWindow,
      createMaestroSibling: h.createMaestroSibling,
      deleteConversation: h.deleteConversation,
      isConversationReserved: h.isConversationReserved,
      applyMaestroStrategyProfile: h.applyMaestroStrategyProfile,
      markMaestroStrategyProfileUsed: h.markMaestroStrategyProfileUsed,
    })

    const result = await mhandles.get('plan:decide')?.({} as never, source.id, {
      action: 'approve',
      implementationTarget: 'maestro',
      maestroStrategyProfileId: 'custom-premium',
      editedPlan: '## Edited plan',
    })

    expect(result).toEqual({ ok: true, conversationId: maestro.id })
    expect(h.createMaestroSibling).toHaveBeenCalledWith(source.id, {
      experience: 'maestro',
      name: 'Checkout · Maestro',
    })
    expect(h.commitPlanDecision).toHaveBeenCalledWith(source.id, 'approve')
    expect(h.applyMaestroStrategyProfile).toHaveBeenCalledExactlyOnceWith(maestro.id, 'custom-premium')
    expect(h.markMaestroStrategyProfileUsed).toHaveBeenCalledExactlyOnceWith('custom-premium')
    expect(h.applyMaestroStrategyProfile.mock.invocationCallOrder[0]).toBeLessThan(
      h.commitPlanDecision.mock.invocationCallOrder[0]!
    )
    expect(sendToWindow).toHaveBeenCalledWith('conversation:open', {
      conversation: maestro,
      focus: true,
    })
    expect(h.runApprovedPlan).toHaveBeenCalledExactlyOnceWith(maestro.id, '## Edited plan')
    expect(h.setChatMode).not.toHaveBeenCalled()
    expect(sendToWindow).not.toHaveBeenCalledWith(`chat:mode:${source.id}`, expect.anything())
    expect(h.runApprovedPlan).not.toHaveBeenCalledWith(source.id, expect.anything())
    expect(h.deleteConversation).not.toHaveBeenCalled()
  })

  it('sibling creation failure leaves the plan pending for retry', async () => {
    const { reg, mhandles } = createTestRegistrar()
    h.getConversation.mockReturnValue({ id: 'conv-standard', name: 'Feature', experience: 'standard' })
    h.decidePlan.mockReturnValue({ action: 'approve', approvedPlan: '# Plan' })
    h.createMaestroSibling.mockRejectedValue(new Error('workspace.siblingSourceInvalid'))
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      createMaestroSibling: h.createMaestroSibling,
      deleteConversation: h.deleteConversation,
      applyMaestroStrategyProfile: h.applyMaestroStrategyProfile,
    })

    const result = await mhandles.get('plan:decide')?.({} as never, 'conv-standard', {
      action: 'approve',
      implementationTarget: 'maestro',
    })

    expect(result).toEqual({ ok: false, error: 'workspace.siblingSourceInvalid' })
    expect(h.commitPlanDecision).not.toHaveBeenCalled()
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })

  it('removed or unavailable profiles roll back before consuming the plan', async () => {
    const { reg, mhandles } = createTestRegistrar()
    const maestro = { id: 'conv-maestro', name: 'Feature · Maestro', experience: 'maestro' }
    h.getConversation.mockReturnValue({ id: 'conv-standard', name: 'Feature', experience: 'standard' })
    h.decidePlan.mockReturnValue({ action: 'approve', approvedPlan: '# Plan' })
    h.createMaestroSibling.mockResolvedValue(maestro)
    h.applyMaestroStrategyProfile.mockResolvedValue({ ok: false, error: 'maestro-strategy-profile-not-found' })
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      createMaestroSibling: h.createMaestroSibling,
      deleteConversation: h.deleteConversation,
      applyMaestroStrategyProfile: h.applyMaestroStrategyProfile,
    })

    const result = await mhandles.get('plan:decide')?.({} as never, 'conv-standard', {
      action: 'approve',
      implementationTarget: 'maestro',
      maestroStrategyProfileId: 'removed-profile',
    })

    expect(result).toEqual({ ok: false, error: 'maestro-strategy-profile-not-found' })
    expect(h.applyMaestroStrategyProfile).toHaveBeenCalledWith(maestro.id, 'removed-profile')
    expect(h.deleteConversation).toHaveBeenCalledExactlyOnceWith(maestro.id)
    expect(h.commitPlanDecision).not.toHaveBeenCalled()
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })

  it('a stale Maestro decision removes the unstarted sibling', async () => {
    const { reg, mhandles } = createTestRegistrar()
    const maestro = { id: 'conv-maestro', name: 'Feature · Maestro', experience: 'maestro' }
    h.getConversation.mockReturnValue({ id: 'conv-standard', name: 'Feature', experience: 'standard' })
    h.decidePlan.mockReturnValue({ action: 'approve', approvedPlan: '# Plan' })
    h.commitPlanDecision.mockReturnValue(false)
    h.createMaestroSibling.mockResolvedValue(maestro)
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      createMaestroSibling: h.createMaestroSibling,
      deleteConversation: h.deleteConversation,
      applyMaestroStrategyProfile: h.applyMaestroStrategyProfile,
    })

    const result = await mhandles.get('plan:decide')?.({} as never, 'conv-standard', {
      action: 'approve',
      implementationTarget: 'maestro',
    })

    expect(result).toEqual({ ok: false, error: 'plan-decision-stale' })
    expect(h.deleteConversation).toHaveBeenCalledExactlyOnceWith(maestro.id)
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })

  it('an active review loop blocks handoff before creating a sibling or consuming the plan', async () => {
    const { reg, mhandles } = createTestRegistrar()
    h.getConversation.mockReturnValue({ id: 'conv-standard', name: 'Feature', experience: 'standard' })
    h.decidePlan.mockReturnValue({ action: 'approve', approvedPlan: '# Plan' })
    h.isConversationReserved.mockReturnValue(true)
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      createMaestroSibling: h.createMaestroSibling,
      deleteConversation: h.deleteConversation,
      isConversationReserved: h.isConversationReserved,
      applyMaestroStrategyProfile: h.applyMaestroStrategyProfile,
    })

    const result = await mhandles.get('plan:decide')?.({} as never, 'conv-standard', {
      action: 'approve',
      implementationTarget: 'maestro',
    })

    expect(result).toEqual({ ok: false, error: 'plan-maestro-source-reserved' })
    expect(h.createMaestroSibling).not.toHaveBeenCalled()
    expect(h.commitPlanDecision).not.toHaveBeenCalled()
  })

  it('revise (chat) starts a revision turn with feedback without changing modes', () => {
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.decidePlan.mockReturnValue({ action: 'revise', feedbackText: 'redo with X' })
    registerPlanIpc(reg, { sendToWindow })

    mhandles.get('plan:decide')?.({} as never, 'conv-chat', { action: 'revise', feedback: 'X' })

    expect(h.runPlanRevision).toHaveBeenCalledWith('conv-chat', 'redo with X')
    expect(h.setChatMode).not.toHaveBeenCalled()
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })

  it('discard (chat) neither starts a turn nor changes modes', () => {
    const { reg, mhandles } = createTestRegistrar()
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.decidePlan.mockReturnValue({ action: 'discard' })
    registerPlanIpc(reg, { sendToWindow: vi.fn() })

    mhandles.get('plan:decide')?.({} as never, 'conv-chat', { action: 'discard' })

    expect(h.runApprovedPlan).not.toHaveBeenCalled()
    expect(h.runPlanRevision).not.toHaveBeenCalled()
    expect(h.setChatMode).not.toHaveBeenCalled()
  })

  it('revise (Web) resolves the correct review without starting a Maestrly revision', () => {
    const { reg, mhandles } = createTestRegistrar()
    const resolveChatGptWebPlanReview = vi.fn(() => ({ ok: true }))
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.decidePlan.mockReturnValue({
      action: 'revise',
      feedbackText: 'structured feedback',
      route: { kind: 'chatgpt-web', reviewId: 'pr_web_v1' },
    })
    registerPlanIpc(reg, { sendToWindow: vi.fn(), resolveChatGptWebPlanReview })

    mhandles.get('plan:decide')?.({} as never, 'conv-chat', { action: 'revise' })

    expect(resolveChatGptWebPlanReview).toHaveBeenCalledWith('conv-chat', 'pr_web_v1', {
      status: 'revise',
      feedbackText: 'structured feedback',
    })
    expect(h.runPlanRevision).not.toHaveBeenCalled()
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })

  it('approve (Web) publishes approved and retains Agent mode with Maestrly implementation', () => {
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    const resolveChatGptWebPlanReview = vi.fn(() => ({ ok: true }))
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.decidePlan.mockReturnValue({
      action: 'approve',
      approvedPlan: '# aprovado',
      route: { kind: 'chatgpt-web', reviewId: 'pr_web_v2' },
    })
    registerPlanIpc(reg, { sendToWindow, resolveChatGptWebPlanReview })

    mhandles.get('plan:decide')?.({} as never, 'conv-chat', { action: 'approve' })

    expect(resolveChatGptWebPlanReview).toHaveBeenCalledWith('conv-chat', 'pr_web_v2', { status: 'approved' })
    expect(h.setChatMode).toHaveBeenCalledWith('conv-chat', 'agent')
    expect(sendToWindow).toHaveBeenCalledWith('chat:mode:conv-chat', 'agent')
    expect(h.runApprovedPlan).toHaveBeenCalledWith('conv-chat', '# aprovado')
  })

  it('Maestro approval (Web) removes the sibling and stays pending when the companion does not confirm', async () => {
    const { reg, mhandles } = createTestRegistrar()
    const resolveChatGptWebPlanReview = vi.fn(() => ({ ok: false, error: 'plan-review-unavailable' }))
    const maestro = { id: 'conv-maestro', name: 'Feature · Maestro', experience: 'maestro' }
    h.getConversation.mockReturnValue({ id: 'conv-standard', name: 'Feature', experience: 'standard' })
    h.decidePlan.mockReturnValue({
      action: 'approve',
      approvedPlan: '# aprovado',
      route: { kind: 'chatgpt-web', reviewId: 'pr_web_maestro' },
    })
    h.createMaestroSibling.mockResolvedValue(maestro)
    registerPlanIpc(reg, {
      sendToWindow: vi.fn(),
      resolveChatGptWebPlanReview,
      createMaestroSibling: h.createMaestroSibling,
      deleteConversation: h.deleteConversation,
      applyMaestroStrategyProfile: h.applyMaestroStrategyProfile,
    })

    const result = await mhandles.get('plan:decide')?.({} as never, 'conv-standard', {
      action: 'approve',
      implementationTarget: 'maestro',
    })

    expect(result).toEqual({ ok: false, error: 'plan-review-unavailable' })
    expect(resolveChatGptWebPlanReview).toHaveBeenCalledWith('conv-standard', 'pr_web_maestro', {
      status: 'approved',
    })
    expect(h.deleteConversation).toHaveBeenCalledExactlyOnceWith(maestro.id)
    expect(h.commitPlanDecision).not.toHaveBeenCalled()
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })

  it('discard (Web) publishes discarded without starting a turn', () => {
    const { reg, mhandles } = createTestRegistrar()
    const resolveChatGptWebPlanReview = vi.fn(() => ({ ok: true }))
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.decidePlan.mockReturnValue({
      action: 'discard',
      route: { kind: 'chatgpt-web', reviewId: 'pr_web_discard' },
    })
    registerPlanIpc(reg, { sendToWindow: vi.fn(), resolveChatGptWebPlanReview })

    mhandles.get('plan:decide')?.({} as never, 'conv-chat', { action: 'discard' })

    expect(resolveChatGptWebPlanReview).toHaveBeenCalledWith('conv-chat', 'pr_web_discard', {
      status: 'discarded',
    })
    expect(h.runPlanRevision).not.toHaveBeenCalled()
    expect(h.runApprovedPlan).not.toHaveBeenCalled()
  })

  it('missing companion during Web revision returns an observable error without fallback', () => {
    const { reg, mhandles } = createTestRegistrar()
    h.getConversation.mockReturnValue({ cli: 'chat' })
    h.decidePlan.mockReturnValue({
      action: 'revise',
      feedbackText: 'do not redirect',
      route: { kind: 'chatgpt-web', reviewId: 'pr_missing' },
    })
    registerPlanIpc(reg, { sendToWindow: vi.fn() })

    const result = mhandles.get('plan:decide')?.({} as never, 'conv-chat', { action: 'revise' })

    expect(result).toEqual({ ok: false, error: 'plan-review-unavailable' })
    expect(h.commitPlanDecision).not.toHaveBeenCalled()
    expect(h.runPlanRevision).not.toHaveBeenCalled()
  })

  it('every approved conversation starts a Chat turn', () => {
    const { reg, mhandles } = createTestRegistrar()
    h.getConversation.mockReturnValue({})
    h.decidePlan.mockReturnValue({ action: 'approve', approvedPlan: '## Plan' })
    registerPlanIpc(reg, { sendToWindow: vi.fn() })

    mhandles.get('plan:decide')?.({} as never, 'conv-cli', { action: 'approve' })

    expect(h.decidePlan).toHaveBeenCalledWith('conv-cli', { action: 'approve' }, { deferCommit: true })
    expect(h.runApprovedPlan).toHaveBeenCalledWith('conv-cli', '## Plan')
    expect(h.setChatMode).toHaveBeenCalledWith('conv-cli', 'agent')
  })

  it('writes an internal workspace reference with line and range and requests VS Code focus', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-open-file-'))
    tempRoots.push(root)
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'view.tsx'), '')
    h.getConversation.mockReturnValue({ cwd: root })
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    registerPlanIpc(reg, { sendToWindow })

    await mhandles.get('plan:open-file')?.({} as never, 'conv-1', './src/../src/view.tsx', 12, 18)

    const payload = JSON.parse(await fs.readFile(path.join(root, '.maestrly', 'agent-open-file.json'), 'utf8'))
    expect(payload).toMatchObject({ rel: 'src/view.tsx', line: 12, endLine: 18 })
    expect(payload.ts).toEqual(expect.any(Number))
    expect(h.excludeFromGitInfo).toHaveBeenCalledWith(root, ['.maestrly/agent-open-file.json'])
    expect(h.focusFloatIfAny).toHaveBeenCalledWith('conv-1', 'vscode')
    expect(sendToWindow).toHaveBeenCalledWith('debug:ensure-vscode', 'conv-1')
  })

  it('rejects references outside the workspace without creating a sidecar or focusing the editor', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-open-file-'))
    tempRoots.push(root)
    h.getConversation.mockReturnValue({ cwd: root })
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    registerPlanIpc(reg, { sendToWindow })

    await mhandles.get('plan:open-file')?.({} as never, 'conv-1', '../outside.ts', 1)

    await expect(fs.access(path.join(root, '.maestrly', 'agent-open-file.json'))).rejects.toThrow()
    expect(h.excludeFromGitInfo).not.toHaveBeenCalled()
    expect(h.focusFloatIfAny).not.toHaveBeenCalled()
    expect(sendToWindow).not.toHaveBeenCalled()
  })

  it('ignores invalid lines while opening a valid file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-open-file-'))
    tempRoots.push(root)
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'view.tsx'), '')
    h.getConversation.mockReturnValue({ cwd: root })
    const { reg, mhandles } = createTestRegistrar()
    registerPlanIpc(reg, { sendToWindow: vi.fn() })

    await mhandles.get('plan:open-file')?.({} as never, 'conv-1', 'src/view.tsx', 0, 20)

    const payload = JSON.parse(await fs.readFile(path.join(root, '.maestrly', 'agent-open-file.json'), 'utf8'))
    expect(payload).toMatchObject({ rel: 'src/view.tsx', line: null, endLine: null })
  })

  it.runIf(process.platform !== 'win32')('rejects a symlink whose canonical target escapes the workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-open-file-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-open-file-outside-'))
    tempRoots.push(root, outside)
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(outside, 'secret.ts'), 'secret')
    await fs.symlink(path.join(outside, 'secret.ts'), path.join(root, 'src', 'link.ts'))
    h.getConversation.mockReturnValue({ cwd: root })
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    registerPlanIpc(reg, { sendToWindow })

    await mhandles.get('plan:open-file')?.({} as never, 'conv-1', 'src/link.ts', 1)

    await expect(fs.access(path.join(root, '.maestrly', 'agent-open-file.json'))).rejects.toThrow()
    expect(h.focusFloatIfAny).not.toHaveBeenCalled()
    expect(sendToWindow).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')('does not write a sidecar when .maestrly is an external symlink', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-open-file-'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-open-file-outside-'))
    tempRoots.push(root, outside)
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'src', 'view.tsx'), '')
    await fs.symlink(outside, path.join(root, '.maestrly'))
    h.getConversation.mockReturnValue({ cwd: root })
    const { reg, mhandles } = createTestRegistrar()
    const sendToWindow = vi.fn()
    registerPlanIpc(reg, { sendToWindow })

    await mhandles.get('plan:open-file')?.({} as never, 'conv-1', 'src/view.tsx', 1)

    await expect(fs.access(path.join(outside, 'agent-open-file.json'))).rejects.toThrow()
    expect(h.focusFloatIfAny).not.toHaveBeenCalled()
    expect(sendToWindow).not.toHaveBeenCalled()
  })
})
