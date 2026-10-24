import { describe, expect, it, vi } from 'vitest'
import { ConversationNotices } from '../../src/main/notifications/conversation-notices'
import type { SystemNotice } from '../../src/main/notifications/system-notices'

function setup(seen = new Set<string>()) {
  const shown: SystemNotice[] = []
  const dismissed: string[] = []
  const open = vi.fn()
  const notices = new ConversationNotices({
    notices: { show: (notice) => void shown.push(notice), dismiss: (key) => void dismissed.push(key) },
    sees: (id) => seen.has(id),
    label: (id) => (id === 'chat-1' ? { name: 'Fix login', projectName: 'Maestrly' } : null),
    open,
  })
  return { notices, shown, dismissed, open }
}
const view = ({ key, title, subtitle, body }: SystemNotice) => ({ key, title, subtitle, body })

describe('ConversationNotices', () => {
  it('tells a turn that ended, failed, or asks, by the conversation name and project', () => {
    const s = setup()
    expect(s.notices.status('chat-1', 'working')).toBeNull()
    expect(s.notices.status('chat-1', 'ready')).toBe('finished')
    expect(s.notices.status('chat-1', 'error')).toBe('failed')
    expect(s.notices.status('chat-1', 'asking')).toBe('question')
    expect(s.notices.status('chat-1', 'idle')).toBeNull()
    expect(s.shown.map(view)).toEqual([
      { key: 'conversation:chat-1', title: 'Fix login', subtitle: 'Maestrly', body: 'Finished its turn' },
      { key: 'conversation:chat-1', title: 'Fix login', subtitle: 'Maestrly', body: 'The turn failed' },
      { key: 'conversation:chat-1', title: 'Fix login', subtitle: 'Maestrly', body: 'Has a question for you' },
    ])
    s.shown[0].onClick()
    expect(s.open).toHaveBeenCalledWith('chat-1')
  })

  it('tells a plan once: the turn that brought it ends without another notice', () => {
    const s = setup()
    expect(s.notices.plan('chat-2')).toBe('plan')
    expect(s.notices.status('chat-2', 'ready')).toBeNull()
    s.notices.status('chat-2', 'working')
    expect(s.notices.status('chat-2', 'ready')).toBe('finished')
    expect(s.shown.map(({ title, body }) => [title, body])).toEqual([
      ['Conversation', 'Has a plan for you to review'],
      ['Conversation', 'Finished its turn'],
    ])
  })

  it('stays quiet about a status that changed without needing the owner', () => {
    const s = setup()
    s.notices.status('chat-1', 'working', false)
    expect(s.notices.status('chat-1', 'ready', false)).toBeNull()
    expect(s.shown).toEqual([])
  })

  it('stays quiet about the conversation the owner looks at, and removes a notice once it is seen', () => {
    const s = setup(new Set(['chat-1']))
    expect(s.notices.status('chat-1', 'ready')).toBe('finished')
    expect(s.shown).toEqual([])
    s.notices.seen('chat-1')
    expect(s.dismissed).toEqual(['conversation:chat-1'])
  })
})
