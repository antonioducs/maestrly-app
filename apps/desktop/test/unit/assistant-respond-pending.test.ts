import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pending: { permissions: [] as unknown[], questions: [] as unknown[] },
  replyPermission: vi.fn(),
  replyQuestion: vi.fn(),
}))
vi.mock('../../src/main/chat/service', () => ({
  chatPendingInteractions: () => h.pending,
  replyChatPermission: h.replyPermission,
  replyChatQuestion: h.replyQuestion,
}))
vi.mock('../../src/main/store', () => ({
  getConversation: (id: string) => (id === 'deploy' ? { id, name: 'Deploy', archived: 0 } : undefined),
}))

import type { BotToolServer } from '../../src/main/assistant/bot-tools'
import { type RespondPendingDeps, respondPending } from '../../src/main/assistant/respond-pending'
import { assistantActionBudget } from '../../src/main/assistant/action-budget'
import {
  clearHumanTurnOrigin,
  type HumanTurnOrigin,
  recordHumanTurnOrigin,
} from '../../src/main/chat/conversation-dispatch-authorization'
import { setAssistantRoleResolver } from '../../src/main/chat/harness/assistant-role'
import { assistantRuntimeFor, respondPendingInputSchema } from '../../src/main/chat/tools/assistant'

const question = {
  messageId: 'm',
  toolCallId: 'call-1',
  questions: [{ header: 'Branch', question: 'Which branch?', options: [{ label: 'main' }, { label: 'develop' }] }],
}
const permission = {
  id: 'req-1',
  conversationId: 'deploy',
  toolName: 'bash',
  action: 'bash',
  title: 'Run a command',
  resources: [],
  preview: 'npm publish',
}

function botServer(): BotToolServer {
  return {
    fleet: { call: vi.fn() as never, hasFeature: () => true, idempotencyKey: () => 'k' },
    name: 'vps.example',
    connected: true,
    snapshot: () => ({
      bots: [{ id: 'reviewer', name: 'Reviewer' }] as never,
      inbox: [
        {
          botId: 'reviewer',
          interaction: {
            kind: 'permission',
            id: 'perm-1',
            at: '',
            title: 'Run npm test',
            detail: 'npm test',
            tool: null,
            itemId: 'x',
          },
        },
        {
          botId: 'reviewer',
          interaction: {
            kind: 'question',
            id: 'q-1',
            at: '',
            questions: [
              { question: 'Merge?', header: null, options: [{ label: 'Yes', description: null }], multiSelect: false },
            ],
            itemId: 'y',
          },
        },
        { botId: 'reviewer', interaction: { kind: 'help', id: 'help-1', at: '', reason: 'Captcha', itemId: 'z' } },
      ] as never,
    }),
  }
}

function deps(patch: Partial<RespondPendingDeps> = {}) {
  const server = botServer()
  const d = {
    localPending: vi.fn((id: string) =>
      id === 'deploy' ? { name: 'Deploy', permissions: [permission], questions: [question] } : null
    ),
    replyPermission: vi.fn(),
    replyQuestion: vi.fn(),
    botServer: vi.fn((id: string) => (id === 'vps' ? server : null)),
    resolveBot: vi.fn(async () => undefined),
    admit: vi.fn(async () => true),
    confirmApproval: vi.fn(async () => true),
    ...patch,
  }
  return d as typeof d & RespondPendingDeps
}

describe('answering pending items', () => {
  it('answers a local question with one of its options, within the budget', async () => {
    const d = deps()
    const result = await respondPending(d, {
      ref: 'local:deploy',
      itemId: 'question:call-1',
      answer: { kind: 'question', option: 'DEVELOP' },
    })
    expect(result).toEqual({ ok: true, status: 'answered', target: 'Deploy' })
    expect(d.admit).toHaveBeenCalledWith('local:deploy', { kind: 'answer', targetName: 'Deploy', preview: 'develop' })
    expect(d.replyQuestion).toHaveBeenCalledWith('call-1', [['develop']])
    expect(d.confirmApproval).not.toHaveBeenCalled()
  })

  it('refuses an option the question does not offer', async () => {
    const d = deps()
    const result = await respondPending(d, {
      ref: 'local:deploy',
      itemId: 'question:call-1',
      answer: { kind: 'question', option: 'release' },
    })
    expect(result).toEqual({
      ok: false,
      code: 'invalid',
      error: '"release" is not an option. The options are: main, develop.',
    })
    expect(d.replyQuestion).not.toHaveBeenCalled()
  })

  it('always asks before approving, and approves nothing when the person declines', async () => {
    const declined = deps({ confirmApproval: vi.fn(async () => false) })
    const input = {
      ref: 'local:deploy',
      itemId: 'permission:req-1',
      answer: { kind: 'permission', decision: 'allow' },
    } as const
    expect(await respondPending(declined, input)).toMatchObject({ ok: false, code: 'declined' })
    expect(declined.confirmApproval).toHaveBeenCalledWith({
      kind: 'respond',
      targetName: 'Deploy',
      preview: 'Run a command\n\nnpm publish',
    })
    expect(declined.replyPermission).not.toHaveBeenCalled()

    const approved = deps()
    expect(await respondPending(approved, input)).toEqual({ ok: true, status: 'approved', target: 'Deploy' })
    expect(approved.replyPermission).toHaveBeenCalledWith('req-1', 'once')
    expect(approved.admit).not.toHaveBeenCalled()
  })

  it('denies without asking', async () => {
    const d = deps()
    const result = await respondPending(d, {
      ref: 'local:deploy',
      itemId: 'permission:req-1',
      answer: { kind: 'permission', decision: 'deny' },
    })
    expect(result).toEqual({ ok: true, status: 'denied', target: 'Deploy' })
    expect(d.replyPermission).toHaveBeenCalledWith('req-1', 'reject')
    expect(d.confirmApproval).not.toHaveBeenCalled()
  })

  it("resolves a bot's pending permission and question through the gateway", async () => {
    const d = deps()
    expect(
      await respondPending(d, {
        ref: 'bot:vps:reviewer',
        itemId: 'permission:perm-1',
        answer: { kind: 'permission', decision: 'allow' },
      })
    ).toEqual({ ok: true, status: 'approved', target: 'Reviewer' })
    expect(d.confirmApproval).toHaveBeenCalledWith({
      kind: 'respond',
      targetName: 'Reviewer',
      preview: 'Run npm test\n\nnpm test',
    })
    expect(d.resolveBot).toHaveBeenLastCalledWith(expect.anything(), 'reviewer', 'perm-1', {
      kind: 'permission',
      reply: 'once',
    })

    await respondPending(d, {
      ref: 'bot:vps:reviewer',
      itemId: 'question:q-1',
      answer: { kind: 'question', option: 'yes' },
    })
    expect(d.resolveBot).toHaveBeenLastCalledWith(expect.anything(), 'reviewer', 'q-1', {
      kind: 'question',
      answers: [['Yes']],
    })
    expect(
      await respondPending(d, {
        ref: 'bot:vps:reviewer',
        itemId: 'help:help-1',
        answer: { kind: 'question', option: 'x' },
      })
    ).toMatchObject({ code: 'unavailable' })
  })

  it('sends a remote ref to the app, and says when the item is gone or the answer is of the wrong kind', async () => {
    const d = deps()
    expect(
      await respondPending(d, {
        ref: 'host:srv/ws:c-1',
        itemId: 'question:t',
        answer: { kind: 'question', option: 'main' },
      })
    ).toMatchObject({ ok: false, code: 'unavailable' })
    expect(
      await respondPending(d, {
        ref: 'local:deploy',
        itemId: 'permission:gone',
        answer: { kind: 'permission', decision: 'deny' },
      })
    ).toEqual({
      ok: false,
      code: 'not-found',
      error: 'That pending item is gone: it was already answered or ended. Call maestrly_overview again.',
    })
    expect(
      await respondPending(d, {
        ref: 'local:deploy',
        itemId: 'permission:req-1',
        answer: { kind: 'question', option: 'main' },
      })
    ).toMatchObject({ code: 'invalid' })
    expect(d.replyPermission).not.toHaveBeenCalled()
    expect(d.resolveBot).not.toHaveBeenCalled()
  })

  it('validates the answer shape at the schema boundary', () => {
    const ok = { ref: 'local:a', itemId: 'question:x', answer: { kind: 'question', option: 'main' } }
    expect(respondPendingInputSchema.safeParse(ok).success).toBe(true)
    expect(
      respondPendingInputSchema.safeParse({ ...ok, answer: { kind: 'permission', decision: 'always' } }).success
    ).toBe(false)
  })
})

describe('the assistant runtime', () => {
  const humans: HumanTurnOrigin[] = []
  afterEach(() => {
    for (const origin of humans.splice(0)) clearHumanTurnOrigin(origin.conversationId, origin.token)
    setAssistantRoleResolver(null)
    assistantActionBudget.clear('message:typed-1')
    vi.clearAllMocks()
  })

  function runtime() {
    setAssistantRoleResolver((id) => id === 'assistant')
    const origin = {
      token: {},
      conversationId: 'assistant',
      messageId: 'typed-1',
      text: 'aprova',
      signal: new AbortController().signal,
    }
    recordHumanTurnOrigin(origin)
    humans.push(origin)
    return assistantRuntimeFor('assistant', 'agent')!
  }

  it('confirms an approval in a card without "allow the rest" and replies to the broker', async () => {
    h.pending = { permissions: [permission], questions: [] }
    const askQuestion = vi.fn(async () => [['Approve']])
    const result = await runtime().respondPending(
      { ref: 'local:deploy', itemId: 'permission:req-1', answer: { kind: 'permission', decision: 'allow' } },
      askQuestion
    )
    expect(result).toEqual({ ok: true, status: 'approved', target: 'Deploy' })
    expect(askQuestion).toHaveBeenCalledWith([
      {
        header: 'Assistant',
        question: 'Approve this in “Deploy”?\n\nRun a command\n\nnpm publish',
        options: [{ label: 'Approve' }, { label: 'Cancel' }],
      },
    ])
    expect(h.replyPermission).toHaveBeenCalledWith('req-1', 'once')
  })

  it('does not approve when the card is cancelled, and never answers for the assistant itself', async () => {
    h.pending = { permissions: [permission], questions: [] }
    const rt = runtime()
    const cancelled = await rt.respondPending(
      { ref: 'local:deploy', itemId: 'permission:req-1', answer: { kind: 'permission', decision: 'allow' } },
      async () => [['Cancel']]
    )
    expect(cancelled).toMatchObject({ ok: false, code: 'declined' })
    expect(
      await rt.respondPending(
        { ref: 'local:assistant', itemId: 'permission:req-1', answer: { kind: 'permission', decision: 'deny' } },
        async () => []
      )
    ).toMatchObject({ code: 'not-found' })
    expect(h.replyPermission).not.toHaveBeenCalled()
  })
})
