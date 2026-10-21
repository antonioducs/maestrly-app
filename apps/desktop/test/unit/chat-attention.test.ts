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
})
