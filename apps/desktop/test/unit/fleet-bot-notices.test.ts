import { describe, expect, it, vi } from 'vitest'
import type { FleetActivityEntry } from '@maestrly/bot-fleet-protocol'
import { FleetBotNotices } from '../../src/main/notifications/bot-notices'
import type { SystemNotice } from '../../src/main/notifications/system-notices'
import type { FleetServerId } from '../../src/shared/fleet-servers'

const S1 = 'aaaaaaaa-0000-4000-8000-000000000001' as FleetServerId

const entry = (
  kind: FleetActivityEntry['kind'],
  data: FleetActivityEntry['data'] = {},
  summary: string | null = null
): FleetActivityEntry => ({ seq: 1, at: '2026-01-01T00:00:00Z', botId: 'alex', environmentId: null, kind, summary, data })

function setup(seen = false) {
  const shown: SystemNotice[] = []
  const dismissed: string[] = []
  const marks = new Set<string>()
  const open = vi.fn()
  const notices = new FleetBotNotices({
    notices: { show: (notice) => void shown.push(notice), dismissPrefix: (prefix) => void dismissed.push(prefix) },
    attention: {
      mark: (serverId, botId) => void marks.add(`${serverId}/${botId}`),
      clear: (serverId, botId) => marks.delete(`${serverId}/${botId}`),
    },
    sees: () => seen,
    botName: (_serverId, botId) => (botId === 'alex' ? 'Alex' : null),
    serverName: () => null,
    open,
  })
  return { notices, shown, dismissed, marks, open }
}
const view = ({ key, title, subtitle, body }: SystemNotice) => ({ key, title, subtitle, body })

describe('FleetBotNotices', () => {
  it('tells and marks a finished turn, and opens where it happened', () => {
    const s = setup()
    s.notices.live(S1, entry('turn_completed', { source: 'owner' }, 'The report is ready.'))
    s.notices.live(S1, entry('turn_completed', { source: 'routine', runId: 'run-1', alert: true }))
    s.notices.live(S1, entry('needs_you', { threadId: 't-1' }))
    expect(s.shown.map(view)).toEqual([
      {
        key: `bot:${S1}/alex:main`,
        title: 'Alex',
        subtitle: undefined,
        body: 'Finished what you asked — The report is ready.',
      },
      { key: `bot:${S1}/alex:run:run-1`, title: 'Alex', subtitle: undefined, body: 'Finished a routine run' },
      {
        key: `bot:${S1}/alex:thread:t-1`,
        title: 'Alex',
        subtitle: undefined,
        body: 'Paused a conversation with another bot',
      },
    ])
    expect([...s.marks]).toEqual([`${S1}/alex`])
    s.shown[1].onClick()
    s.shown[2].onClick()
    expect(s.open.mock.calls).toEqual([
      [{ kind: 'bot', serverId: S1, botId: 'alex', runId: 'run-1' }],
      [{ kind: 'bot', serverId: S1, botId: 'alex', threadId: 't-1' }],
    ])
  })

  it('marks a bot that answered another bot without telling, and tells what waits without marking', () => {
    const s = setup()
    s.notices.live(S1, entry('turn_completed', { source: 'peer' }))
    expect(s.shown).toEqual([])
    expect([...s.marks]).toEqual([`${S1}/alex`])
    s.marks.clear()
    s.notices.live(S1, entry('needs_you', {}, 'Bash'))
    expect(s.shown.map(({ body }) => body)).toEqual(['Needs you'])
    expect(s.marks.size).toBe(0)
  })

  it('stays quiet about the bot the owner looks at', () => {
    const s = setup(true)
    s.notices.live(S1, entry('turn_failed', { source: 'owner' }))
    expect(s.shown).toEqual([])
    expect(s.marks.size).toBe(0)
  })

  it('clears the mark and the notices of a bot the owner sees', () => {
    const s = setup()
    s.notices.live(S1, entry('turn_failed', { source: 'owner' }))
    s.notices.seen(S1, 'alex')
    expect(s.marks.size).toBe(0)
    expect(s.dismissed).toEqual([`bot:${S1}/alex:`])
  })
})
