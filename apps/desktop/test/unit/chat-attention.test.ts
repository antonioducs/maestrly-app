import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  buildChatAttentionSnapshot,
  createChatAttentionSync,
  watchChatAttention,
  type ChatAttentionState,
} from '../../src/main/remote-host/server/chat-attention'

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

  it('builds snapshots with mapped attention kinds, sliced names, and non-null filter', () => {
    const longName = 'x'.repeat(250)
    const pendingPlans = new Set(['c-plan'])
    const snapshot = buildChatAttentionSnapshot(
      [
        { id: 'c-plan', name: longName, status: 'ready', marked: false, at: 1_700_000_000_000 },
        { id: 'c-question', name: 'Question', status: 'asking', marked: false, at: 1_700_000_001_000 },
        { id: 'c-waiting', name: 'Approval', status: 'waiting', marked: true, at: 1_700_000_002_000 },
        { id: 'c-failed', name: 'Error', status: 'error', marked: true, at: 1_700_000_003_000 },
        { id: 'c-finished', name: 'Done', status: 'ready', marked: true, at: 1_700_000_004_000 },
        { id: 'c-none', name: 'Quiet', status: 'ready', marked: false, at: 1_700_000_005_000 },
        { id: 'c-working', name: 'Busy', status: 'working', marked: false, at: 1_700_000_006_000 },
        { id: 'c-unmarked-error', name: 'Old error', status: 'error', marked: false, at: 1_700_000_007_000 },
      ],
      (id) => pendingPlans.has(id)
    )
    expect(snapshot).toEqual([
      {
        conversationId: 'c-plan',
        name: 'x'.repeat(200),
        kind: 'plan',
        at: new Date(1_700_000_000_000).toISOString(),
      },
      {
        conversationId: 'c-question',
        name: 'Question',
        kind: 'question',
        at: new Date(1_700_000_001_000).toISOString(),
      },
      {
        conversationId: 'c-waiting',
        name: 'Approval',
        kind: 'waiting',
        at: new Date(1_700_000_002_000).toISOString(),
      },
      {
        conversationId: 'c-failed',
        name: 'Error',
        kind: 'failed',
        at: new Date(1_700_000_003_000).toISOString(),
      },
      {
        conversationId: 'c-finished',
        name: 'Done',
        kind: 'finished',
        at: new Date(1_700_000_004_000).toISOString(),
      },
    ])
  })

  it('emits cleared on each non-null to null transition without duplicates', () => {
    const permissions = new EventEmitter()
    const questions = new EventEmitter()
    const statuses = new EventEmitter()
    const changes = new EventEmitter()
    const stateMap = new Map<string, ChatAttentionState>([
      ['boot-marked', { status: 'ready', marked: true, hasPendingPlan: false, eligible: true }],
      ['c-mark', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true }],
      ['c-wait', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true }],
      ['c-ask', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true }],
      ['c-plan', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true }],
      ['c-plan-marked', { status: 'ready', marked: true, hasPendingPlan: true, eligible: true }],
      ['c-arch', { status: 'ready', marked: true, hasPendingPlan: false, eligible: true }],
    ])
    const published: Array<{ conversationId: string; kind: string }> = []
    const cleared: string[] = []
    const stop = watchChatAttention({
      permissions,
      questions,
      watchStatuses: (listener) => {
        const onStatus = (id: string, status: string) => listener(id, status)
        statuses.on('status', onStatus)
        return () => statuses.off('status', onStatus)
      },
      conversation: (id) => ({ name: `Chat ${id}` }),
      hasPendingPlan: (id) => stateMap.get(id)?.hasPendingPlan ?? false,
      initialAttention: () => [
        { conversationId: 'boot-marked', kind: 'finished' },
        { conversationId: 'c-plan-marked', kind: 'plan' },
        { conversationId: 'c-arch', kind: 'finished' },
      ],
      conversationState: (id) => stateMap.get(id) ?? null,
      watchChanges: (listener) => {
        const onChange = (id: string) => listener(id)
        changes.on('change', onChange)
        return () => changes.off('change', onChange)
      },
      publish: ({ conversationId, kind }) => published.push({ conversationId, kind }),
      publishCleared: (conversationId) => cleared.push(conversationId),
    })

    try {
      // 1. Pre-existing marked conversation gets its mark cleared.
      stateMap.set('boot-marked', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true })
      changes.emit('change', 'boot-marked')
      // Repeated change must not emit a duplicate cleared.
      changes.emit('change', 'boot-marked')

      // 2. Live mark cleared while not waiting/asking/planned (finished -> null).
      stateMap.set('c-mark', { status: 'ready', marked: true, hasPendingPlan: false, eligible: true })
      statuses.emit('status', 'c-mark', 'working')
      statuses.emit('status', 'c-mark', 'ready')
      stateMap.set('c-mark', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true })
      changes.emit('change', 'c-mark')

      // 3. Waiting conversation whose mark is cleared while still waiting does NOT emit cleared;
      //    only when approval is answered and status leaves waiting does it emit cleared.
      stateMap.set('c-wait', { status: 'waiting', marked: true, hasPendingPlan: false, eligible: true })
      permissions.emit('asked', { conversationId: 'c-wait' })
      stateMap.set('c-wait', { status: 'waiting', marked: false, hasPendingPlan: false, eligible: true })
      changes.emit('change', 'c-wait')
      expect(cleared).toEqual(['boot-marked', 'c-mark'])
      stateMap.set('c-wait', { status: 'working', marked: false, hasPendingPlan: false, eligible: true })
      statuses.emit('status', 'c-wait', 'working')

      // 4. Question answered without mark.
      stateMap.set('c-ask', { status: 'asking', marked: false, hasPendingPlan: false, eligible: true })
      questions.emit('asked', { conversationId: 'c-ask' })
      stateMap.set('c-ask', { status: 'working', marked: false, hasPendingPlan: false, eligible: true })
      statuses.emit('status', 'c-ask', 'working')

      // 5. Plan cleared without mark -> emits cleared.
      stateMap.set('c-plan', { status: 'ready', marked: false, hasPendingPlan: true, eligible: true })
      statuses.emit('status', 'c-plan', 'working')
      statuses.emit('status', 'c-plan', 'ready')
      stateMap.set('c-plan', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true })
      changes.emit('change', 'c-plan')

      // 6. Plan cleared while still marked -> stays non-null ('finished'), then mark cleared -> emits cleared.
      stateMap.set('c-plan-marked', { status: 'ready', marked: true, hasPendingPlan: false, eligible: true })
      changes.emit('change', 'c-plan-marked')
      expect(cleared).not.toContain('c-plan-marked')
      stateMap.set('c-plan-marked', { status: 'ready', marked: false, hasPendingPlan: false, eligible: true })
      changes.emit('change', 'c-plan-marked')

      // 7. Archived / deleted (eligible = false) -> emits cleared once even if called twice.
      stateMap.set('c-arch', { status: 'waiting', marked: true, hasPendingPlan: false, eligible: false })
      changes.emit('change', 'c-arch')
      stateMap.delete('c-arch')
      changes.emit('change', 'c-arch')

      expect(cleared).toEqual(['boot-marked', 'c-mark', 'c-wait', 'c-ask', 'c-plan', 'c-plan-marked', 'c-arch'])
      expect(published).toEqual([
        { conversationId: 'c-mark', kind: 'finished' },
        { conversationId: 'c-wait', kind: 'waiting' },
        { conversationId: 'c-ask', kind: 'question' },
        { conversationId: 'c-plan', kind: 'plan' },
      ])
    } finally {
      stop()
    }
  })

  it('tracks alerting routine-run notices in memory, includes them in snapshots, and clears them via clearSeen, watchSeen, new turn, or archive', () => {
    const permissions = new EventEmitter()
    const questions = new EventEmitter()
    const statuses = new EventEmitter()
    const changes = new EventEmitter()
    const seen = new EventEmitter()
    const stateMap = new Map<string, ChatAttentionState>([
      ['r-alert', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: true }],
      ['r-fail', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: true }],
      ['r-quiet', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: true }],
      ['r-seen', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: true }],
      ['r-turn', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: true }],
      ['r-arch', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: true }],
      ['r-idle', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: true }],
    ])
    const runs = new Map<
      string,
      { notify: 'notable' | 'all' | 'none'; outcome: 'notable' | 'nothing_new' | 'done'; active: boolean }
    >([
      ['r-alert', { notify: 'notable', outcome: 'notable', active: true }],
      ['r-fail', { notify: 'none', outcome: 'done', active: true }],
      ['r-quiet', { notify: 'notable', outcome: 'nothing_new', active: true }],
      ['r-seen', { notify: 'all', outcome: 'done', active: true }],
      ['r-turn', { notify: 'notable', outcome: 'notable', active: true }],
      ['r-arch', { notify: 'notable', outcome: 'notable', active: true }],
    ])
    const published: Array<{ conversationId: string; kind: string }> = []
    const cleared: string[] = []
    const sync = createChatAttentionSync({
      permissions,
      questions,
      watchStatuses: (listener) => {
        const onStatus = (id: string, status: string) => listener(id, status)
        statuses.on('status', onStatus)
        return () => statuses.off('status', onStatus)
      },
      conversation: (id) => (stateMap.has(id) ? { name: `Routine ${id}` } : undefined),
      hasPendingPlan: () => false,
      routineRun: (id) => runs.get(id) ?? null,
      conversationState: (id) => stateMap.get(id) ?? null,
      watchChanges: (listener) => {
        const onChange = (id: string) => listener(id)
        changes.on('change', onChange)
        return () => changes.off('change', onChange)
      },
      watchSeen: (listener) => {
        const onSeen = (id: string) => listener(id)
        seen.on('seen', onSeen)
        return () => seen.off('seen', onSeen)
      },
      publish: ({ conversationId, kind }) => published.push({ conversationId, kind }),
      publishCleared: (conversationId) => cleared.push(conversationId),
    })

    try {
      // Alerting routine runs are published and tracked; non-alerting runs are neither published nor tracked.
      for (const id of ['r-alert', 'r-quiet', 'r-seen', 'r-turn', 'r-arch']) {
        statuses.emit('status', id, 'working')
        statuses.emit('status', id, 'ready')
      }
      statuses.emit('status', 'r-fail', 'working')
      stateMap.set('r-fail', { status: 'error', marked: false, hasPendingPlan: false, eligible: false, routine: true })
      statuses.emit('status', 'r-fail', 'error')

      expect(published).toEqual([
        { conversationId: 'r-alert', kind: 'finished' },
        { conversationId: 'r-seen', kind: 'finished' },
        { conversationId: 'r-turn', kind: 'finished' },
        { conversationId: 'r-arch', kind: 'finished' },
        { conversationId: 'r-fail', kind: 'failed' },
      ])
      expect(cleared).toEqual([])

      // Snapshot includes tracked routine notices alongside normal rows and excludes routine chats without a notice.
      const snapshot = buildChatAttentionSnapshot(
        [{ id: 'c-normal', name: 'Normal chat', status: 'ready', marked: true, at: 1_700_000_000_000 }],
        () => false,
        sync.routineSnapshot()
      )
      expect(snapshot.map(({ conversationId, name, kind }) => ({ conversationId, name, kind }))).toEqual([
        { conversationId: 'c-normal', name: 'Normal chat', kind: 'finished' },
        { conversationId: 'r-alert', name: 'Routine r-alert', kind: 'finished' },
        { conversationId: 'r-seen', name: 'Routine r-seen', kind: 'finished' },
        { conversationId: 'r-turn', name: 'Routine r-turn', kind: 'finished' },
        { conversationId: 'r-arch', name: 'Routine r-arch', kind: 'finished' },
        { conversationId: 'r-fail', name: 'Routine r-fail', kind: 'failed' },
      ])

      // 1. Clear route (clearSeen) clears tracked notices and reports true only when one existed.
      expect(sync.clearSeen('r-alert')).toBe(true)
      expect(sync.clearSeen('r-alert')).toBe(false)
      expect(sync.clearSeen('r-quiet')).toBe(false)
      expect(sync.clearSeen('r-idle')).toBe(false)

      // 2. Desktop / mobile seen path (watchSeen) clears even without a DB mark.
      seen.emit('seen', 'r-seen')
      seen.emit('seen', 'r-quiet')

      // 3. New turn (status 'working') clears the notice.
      stateMap.set('r-turn', {
        status: 'working',
        marked: false,
        hasPendingPlan: false,
        eligible: false,
        routine: true,
      })
      statuses.emit('status', 'r-turn', 'working')

      // 4. Archiving clears the notice and drops it from snapshots; clearSeen then reports false.
      stateMap.set('r-arch', { status: 'ready', marked: false, hasPendingPlan: false, eligible: false, routine: false })
      changes.emit('change', 'r-arch')
      expect(sync.clearSeen('r-arch')).toBe(false)

      expect(cleared).toEqual(['r-alert', 'r-seen', 'r-turn', 'r-arch'])
      expect(sync.routineSnapshot().map((item) => item.conversationId)).toEqual(['r-fail'])
    } finally {
      sync.stop()
    }
  })
})
