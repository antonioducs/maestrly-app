import { describe, expect, it, vi } from 'vitest'
import { HostConversationAlerts } from '../../src/main/notifications/host-conversations'
import type { ConversationNoticeKind } from '../../src/main/notifications/conversation-notices'

const HOST = 'aaaaaaaa-0000-4000-8000-000000000001/env-1'
const KEY = `${HOST}#chat-1`

function setup() {
  const calls: unknown[][] = []
  const play = vi.fn()
  const alerts = new HostConversationAlerts({
    notices: {
      status: (key, status, alert) => {
        calls.push(['status', key, status, alert])
        return status === 'ready' ? 'finished' : status === 'asking' ? 'question' : null
      },
      plan: (key) => {
        calls.push(['plan', key])
        return 'plan' as ConversationNoticeKind
      },
      seen: (key) => void calls.push(['seen', key]),
    },
    play,
  })
  return { alerts, calls, play }
}

describe('HostConversationAlerts', () => {
  it('tells and sounds what a host conversation reports once, though each window of the host receives it', () => {
    const s = setup()
    for (const status of ['working', 'working', 'ready', 'ready'])
      s.alerts.event(HOST, 'agent:status', [{ agentId: 'chat-1', status }])
    expect(s.calls).toEqual([
      ['status', KEY, 'working', true],
      ['status', KEY, 'ready', true],
    ])
    expect(s.play).toHaveBeenCalledExactlyOnceWith(KEY, 'ready')
  })

  it('passes on a status that changed without needing the owner', () => {
    const s = setup()
    s.alerts.event(HOST, 'agent:status', [{ agentId: 'chat-1', status: 'ready', alert: false }])
    expect(s.calls).toEqual([['status', KEY, 'ready', false]])
  })

  it('tells each plan once and sounds it, and a plan of a later turn again', () => {
    const s = setup()
    const plan = (version: number) => s.alerts.event(HOST, 'plan:received', [{ agentId: 'chat-1', version }])
    plan(1)
    plan(1)
    plan(2)
    s.alerts.event(HOST, 'agent:status', [{ agentId: 'chat-1', status: 'working' }])
    plan(1)
    expect(s.calls.filter(([kind]) => kind === 'plan')).toHaveLength(3)
    expect(s.play).toHaveBeenCalledWith(KEY, 'plan')
  })

  it('removes the notice once the conversation is seen on any computer, and ignores this computer and bad payloads', () => {
    const s = setup()
    s.alerts.event(HOST, 'conversation:attention', [{ conversationId: 'chat-1', attention: false }])
    s.alerts.event(HOST, 'conversation:attention', [{ conversationId: 'chat-1', attention: true }])
    s.alerts.event('local', 'agent:status', [{ agentId: 'chat-1', status: 'ready' }])
    s.alerts.event(HOST, 'agent:status', [null])
    s.alerts.event(HOST, 'agent:status', [{ agentId: 1, status: 'ready' }])
    expect(s.calls).toEqual([['seen', KEY]])
  })
})
