import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { watchChatAttention } from '../../src/main/remote-host/server/chat-attention'

function setup() {
  const permissions = new EventEmitter()
  const questions = new EventEmitter()
  const statuses = new EventEmitter()
  const published: Array<{ conversationId: string; name: string; kind: string }> = []
  const plans = new Set<string>()
  const stop = watchChatAttention({
    permissions,
    questions,
    watchStatuses: (listener) => {
      const onStatus = (id: string, status: string) => listener(id, status)
      statuses.on('status', onStatus)
      return () => statuses.off('status', onStatus)
    },
    conversation: (id) =>
      id === 'bot'
        ? { name: 'Juno', botOrigin: { botId: 'juno' } }
        : id === 'gone'
          ? undefined
          : { name: `Chat ${id}` },
    hasPendingPlan: (id) => plans.has(id),
    publish: (event) => published.push(event),
  })
  return { permissions, questions, statuses, published, plans, stop }
}

describe('chat attention on a workspaces host', () => {
  it('tells of requests, questions, plans and turns that finished or failed', () => {
    const h = setup()
    h.permissions.emit('asked', { conversationId: 'c1', id: 'r1' })
    h.questions.emit('asked', { conversationId: 'c2', toolCallId: 't1' })
    h.statuses.emit('status', 'c3', 'working')
    h.statuses.emit('status', 'c3', 'ready')
    h.statuses.emit('status', 'c3', 'ready')
    h.plans.add('c4')
    h.statuses.emit('status', 'c4', 'working')
    h.statuses.emit('status', 'c4', 'ready')
    h.statuses.emit('status', 'c5', 'error')
    expect(h.published).toEqual([
      { conversationId: 'c1', name: 'Chat c1', kind: 'waiting' },
      { conversationId: 'c2', name: 'Chat c2', kind: 'question' },
      { conversationId: 'c3', name: 'Chat c3', kind: 'finished' },
      { conversationId: 'c4', name: 'Chat c4', kind: 'plan' },
      { conversationId: 'c5', name: 'Chat c5', kind: 'failed' },
    ])
  })

  it('tells of bot conversations too, leaves out conversations that are gone, and stops when asked', () => {
    const h = setup()
    h.permissions.emit('asked', { conversationId: 'bot' })
    h.statuses.emit('status', 'gone', 'ready')
    h.stop()
    h.permissions.emit('asked', { conversationId: 'c1' })
    h.statuses.emit('status', 'c1', 'ready')
    expect(h.published).toEqual([{ conversationId: 'bot', name: 'Juno', kind: 'waiting' }])
  })

  it('filters routine run completion notifications by notify policy while always notifying waiting, question, and failure', () => {
    const permissions = new EventEmitter()
    const questions = new EventEmitter()
    const statuses = new EventEmitter()
    const published: Array<{ conversationId: string; name: string; kind: string }> = []
    const routines: Record<
      string,
      { notify: 'notable' | 'all' | 'none'; outcome: 'notable' | 'nothing_new' | 'done' | null; active?: boolean }
    > = {
      'run-notable-hit': { notify: 'notable', outcome: 'notable' },
      'run-notable-quiet': { notify: 'notable', outcome: 'nothing_new' },
      'run-all-quiet': { notify: 'all', outcome: 'nothing_new' },
      'run-none-hit': { notify: 'none', outcome: 'notable' },
    }
    const stop = watchChatAttention({
      permissions,
      questions,
      watchStatuses: (listener) => {
        const onStatus = (id: string, status: string) => listener(id, status)
        statuses.on('status', onStatus)
        return () => statuses.off('status', onStatus)
      },
      conversation: (id) => ({
        name: `Routine ${id}`,
      }),
      hasPendingPlan: () => false,
      routineRun: (conversationId) => {
        const entry = routines[conversationId]
        return entry?.outcome ? { notify: entry.notify, outcome: entry.outcome, active: entry.active ?? true } : null
      },
      publish: (event) => published.push(event),
    })
    try {
      for (const id of Object.keys(routines)) {
        statuses.emit('status', id, 'working')
        statuses.emit('status', id, 'ready')
      }
      permissions.emit('asked', { conversationId: 'run-none-hit', id: 'p1' })
      questions.emit('asked', { conversationId: 'run-none-hit', toolCallId: 'q1' })
      statuses.emit('status', 'run-none-hit', 'error')

      expect(published).toEqual([
        { conversationId: 'run-notable-hit', name: 'Routine run-notable-hit', kind: 'finished' },
        { conversationId: 'run-all-quiet', name: 'Routine run-all-quiet', kind: 'finished' },
        { conversationId: 'run-none-hit', name: 'Routine run-none-hit', kind: 'waiting' },
        { conversationId: 'run-none-hit', name: 'Routine run-none-hit', kind: 'question' },
        { conversationId: 'run-none-hit', name: 'Routine run-none-hit', kind: 'failed' },
      ])
    } finally {
      stop()
    }
  })

  it('filters only the turn of the run itself: the owner continuing a finished run hears of each answer', () => {
    const statuses = new EventEmitter()
    const published: Array<{ conversationId: string; kind: string }> = []
    const run = { notify: 'notable' as const, outcome: 'nothing_new' as const, active: true }
    const stop = watchChatAttention({
      permissions: new EventEmitter(),
      questions: new EventEmitter(),
      watchStatuses: (listener) => {
        const onStatus = (id: string, status: string) => listener(id, status)
        statuses.on('status', onStatus)
        return () => statuses.off('status', onStatus)
      },
      conversation: (id) => ({ name: id }),
      hasPendingPlan: () => false,
      routineRun: () => ({ ...run }),
      publish: ({ conversationId, kind }) => published.push({ conversationId, kind }),
    })
    try {
      // The run's turn; the run settles before its turn reports ready, which is still the run's.
      statuses.emit('status', 'run', 'working')
      run.active = false
      statuses.emit('status', 'run', 'ready')
      expect(published).toEqual([])
      // The owner writes in the run's conversation afterwards.
      statuses.emit('status', 'run', 'working')
      statuses.emit('status', 'run', 'ready')
      expect(published).toEqual([{ conversationId: 'run', kind: 'finished' }])
    } finally {
      stop()
    }
  })
})
