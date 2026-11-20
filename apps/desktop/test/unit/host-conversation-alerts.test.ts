import { describe, expect, it, vi } from 'vitest'
import { HostConversationAlerts } from '../../src/main/notifications/host-conversations'
import type { ConversationNoticeKind } from '../../src/main/notifications/conversation-notices'
import { LOCAL_HOST_ID } from '../../src/shared/host-key'

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

  it('forwards remote routines:toast events to RoutineNotices with host label and deduplicates repeated deliveries', () => {
    const routineToasts: Array<{ run: unknown; routine: unknown; host: unknown }> = []
    const play = vi.fn()
    const alerts = new HostConversationAlerts({
      notices: {
        status: () => null,
        plan: () => 'plan' as ConversationNoticeKind,
        seen: () => undefined,
      },
      routines: {
        notifyRun: (run, routine, host) => routineToasts.push({ run, routine, host }),
        seen: () => undefined,
      },
      hostLabel: (hostId) => (hostId === HOST ? 'Workspaces · vps-1' : null),
      play,
    })

    const toast = {
      kind: 'result',
      routine: { id: 'r-1', title: 'Daily digest' },
      run: {
        id: 'run-1',
        routineId: 'r-1',
        scheduledAt: 1000,
        startedAt: 1000,
        finishedAt: 2000,
        trigger: 'schedule',
        status: 'notable',
        summary: '2 PRs need review',
        report: null,
        error: null,
        conversationId: 'conv-1',
        conversationDeleted: false,
        pinned: false,
        unread: true,
      },
    }

    alerts.event(HOST, 'routines:toast', [toast])
    alerts.event(HOST, 'routines:toast', [toast])
    expect(routineToasts).toHaveLength(1)
    expect(routineToasts[0]).toMatchObject({
      host: { hostId: HOST, label: 'Workspaces · vps-1' },
      routine: { id: 'r-1', title: 'Daily digest' },
    })
    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenLastCalledWith(`${HOST}#conv-1`, 'ready')

    // A later status transition on the same run notifies again.
    alerts.event(HOST, 'routines:toast', [{ ...toast, run: { ...toast.run, status: 'failed' } }])
    expect(routineToasts).toHaveLength(2)
    expect(play).toHaveBeenCalledTimes(2)
    expect(play).toHaveBeenLastCalledWith(`${HOST}#conv-1`, 'error')
  })

  it('alerts each request a remote run makes of the owner, and dismisses the run once the host says it was seen', () => {
    const notified: string[] = []
    const seen: string[] = []
    const alerts = new HostConversationAlerts({
      notices: { status: () => null, plan: () => 'plan' as ConversationNoticeKind, seen: () => undefined },
      routines: {
        notifyRun: (run) => notified.push(`${run.status}:${run.waiting?.prompt ?? ''}`),
        seen: (runId) => seen.push(runId),
      },
      play: vi.fn(),
    })
    const run = {
      id: 'run-2',
      routineId: 'r-1',
      scheduledAt: 1000,
      startedAt: 1000,
      finishedAt: null,
      trigger: 'schedule',
      status: 'waiting',
      summary: null,
      report: null,
      error: null,
      conversationId: 'conv-2',
      conversationDeleted: false,
      pinned: false,
      unread: true,
    }
    const waiting = (prompt: string) => ({
      kind: 'result',
      routine: { id: 'r-1', title: 'Deploy' },
      run: { ...run, waiting: { kind: 'approval', prompt } },
    })
    alerts.event(HOST, 'routines:toast', [waiting('git push')])
    alerts.event(HOST, 'routines:toast', [waiting('git push')])
    alerts.event(HOST, 'routines:toast', [waiting('npm publish')])
    expect(notified).toEqual(['waiting:git push', 'waiting:npm publish'])

    alerts.event(HOST, 'routines:seen', [{ runId: 'run-2' }])
    alerts.event(LOCAL_HOST_ID, 'routines:seen', [{ runId: 'run-2' }])
    alerts.event(HOST, 'routines:seen', [{ runId: 7 }])
    expect(seen).toEqual([`${HOST}#run-2`])
  })
})
