import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { getConversation, getWorkspace, listAllConversations } from '../../src/main/store'
import { listSequencedChatMessagesBefore } from '../../src/main/chat/chat-store'
import {
  ASSISTANT_FREE_TARGETS_PER_TURN,
  admitAssistantAction,
  confirmAssistantAction,
  createActionBudget,
} from '../../src/main/assistant/action-budget'
import { type ConversationLinkCaller, createConversationLinkService } from '../../src/main/conversation-link-service'
import { tFor } from '../../src/shared/i18n'
import type { ChatQuestion } from '../../src/shared/chat'

const action = { kind: 'send' as const, targetName: 'Fix login', preview: 'Rebase on main.' }
const answering = (label: string | null) =>
  vi.fn(async (_questions: ChatQuestion[]): Promise<string[][]> => (label === null ? [] : [[label]]))

describe('action budget', () => {
  it('lets three distinct targets through and asks from the fourth on', () => {
    const budget = createActionBudget()
    expect(ASSISTANT_FREE_TARGETS_PER_TURN).toBe(3)
    expect(['a', 'b', 'c'].map((target) => budget.check('message:1', target))).toEqual(['free', 'free', 'free'])
    expect(budget.check('message:1', 'd')).toBe('confirm')
    expect(budget.check('message:1', 'd')).toBe('confirm')
  })

  it('does not spend the budget again on a target already reached', () => {
    const budget = createActionBudget()
    for (const target of ['a', 'b', 'c']) budget.check('message:1', target)
    expect(budget.check('message:1', 'a')).toBe('free')
    expect(budget.check('message:1', 'c')).toBe('free')
  })

  it('keeps each turn apart, frees the rest of a turn on release and starts over on clear', () => {
    const budget = createActionBudget()
    for (const target of ['a', 'b', 'c']) budget.check('message:1', target)
    expect(budget.check('message:2', 'd')).toBe('free')
    budget.release('message:1')
    expect(budget.check('message:1', 'd')).toBe('free')
    expect(budget.check('message:1', 'e')).toBe('free')
    budget.clear('message:1')
    for (const target of ['x', 'y', 'z']) budget.check('message:1', target)
    expect(budget.check('message:1', 'a')).toBe('confirm')
  })

  it('asks once for a target past the budget and remembers the answer', async () => {
    const budget = createActionBudget()
    for (const target of ['a', 'b', 'c']) budget.check('message:1', target)
    const send = answering('Send')
    expect(await admitAssistantAction(send, 'message:1', 'd', action, budget)).toBe(true)
    expect(await admitAssistantAction(send, 'message:1', 'd', action, budget)).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    const cancel = answering('Cancel')
    expect(await admitAssistantAction(cancel, 'message:1', 'e', action, budget)).toBe(false)
    const release = answering('Allow the rest of this request')
    expect(await admitAssistantAction(release, 'message:1', 'e', action, budget)).toBe(true)
    expect(await admitAssistantAction(cancel, 'message:1', 'f', action, budget)).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('confirmation card', () => {
  it('names the target and the message, and offers to allow the rest of the request', async () => {
    const ask = answering('Allow the rest of this request')
    expect(await confirmAssistantAction(ask, action)).toBe('release')
    expect(ask).toHaveBeenCalledWith([
      {
        header: 'Assistant',
        question: 'Send this to “Fix login”?\n\nRebase on main.',
        options: [{ label: 'Send' }, { label: 'Allow the rest of this request' }, { label: 'Cancel' }],
      },
    ])
  })

  it('confirms an approval alone, without the release option', async () => {
    const ask = answering('Approve')
    const approval = { kind: 'respond' as const, targetName: 'Deploy', preview: 'npm publish' }
    expect(await confirmAssistantAction(ask, approval, { allowRelease: false })).toBe('once')
    expect(ask.mock.calls[0]?.[0][0]?.options).toEqual([{ label: 'Approve' }, { label: 'Cancel' }])
    expect(
      await confirmAssistantAction(answering('Allow the rest of this request'), approval, { allowRelease: false })
    ).toBe('cancel')
  })

  it('cancels when the card is dismissed or fails', async () => {
    expect(await confirmAssistantAction(answering(null), action)).toBe('cancel')
    expect(
      await confirmAssistantAction(async () => {
        throw new Error('dismissed')
      }, action)
    ).toBe('cancel')
  })
})

describe('conversation link service with the budget', () => {
  let source: string
  let target: string
  beforeEach(() => {
    freshDb()
    const workspaceId = makeWorkspace({ name: 'Repo' }).id
    source = makeConversation(workspaceId, { name: 'Assistant' }).id
    target = makeConversation(workspaceId, { name: 'Other' }).id
  })
  afterEach(() => closeDb())

  const service = () =>
    createConversationLinkService({
      getConversation,
      listConversations: listAllConversations,
      workspaceName: (id) => (id ? (getWorkspace(id)?.name ?? null) : null),
      isRunning: () => false,
      startPeerTurn: async () => ({ ok: true as const }),
      waitForSlot: async () => undefined,
      messagesPage: (conversationId, opts) =>
        listSequencedChatMessagesBefore(conversationId, opts.beforeSeq, opts.limit),
      sleep: async () => undefined,
      now: () => 1_000,
      text: (key, params) => tFor('en', 'prompts')(key, params),
    })

  const caller = (isAssistant: boolean): ConversationLinkCaller => ({
    conversationId: source,
    originKey: 'message:typed-1',
    kind: 'human',
    hop: 0,
    peerConversationId: null,
    reportBack: false,
    isAssistant,
    assertCurrent: () => undefined,
  })

  it('still asks other callers before messaging a conversation that is not linked', async () => {
    const confirm = vi.fn(async () => true)
    const admit = vi.fn(async () => true)
    const result = await service().send(caller(false), { conversationId: target, message: 'Hi.' }, confirm, admit)
    expect(result).toMatchObject({ ok: true, status: 'delivered' })
    expect(confirm).toHaveBeenCalledOnce()
    expect(admit).not.toHaveBeenCalled()
  })

  it('lets the assistant budget decide instead of the per-message confirmation', async () => {
    const confirm = vi.fn(async () => true)
    const admit = vi.fn(async () => true)
    const result = await service().send(caller(true), { conversationId: target, message: 'Hi.' }, confirm, admit)
    expect(result).toMatchObject({ ok: true, status: 'delivered' })
    expect(confirm).not.toHaveBeenCalled()
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ conversationId: target, name: 'Other' }), 'Hi.')

    const declined = await service().send(
      caller(true),
      { conversationId: target, message: 'Another.' },
      confirm,
      async () => false
    )
    expect(declined).toMatchObject({ ok: false, code: 'declined' })
    expect(confirm).not.toHaveBeenCalled()
  })
})
