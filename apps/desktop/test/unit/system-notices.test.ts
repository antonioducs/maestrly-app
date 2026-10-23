import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  supported: true,
  notifications: [] as {
    options: Record<string, unknown>
    handlers: Map<string, () => void>
    shown: boolean
    closed: boolean
  }[],
}))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return state.supported
    }
    private readonly entry: (typeof state.notifications)[number]
    constructor(options: Record<string, unknown>) {
      this.entry = { options, handlers: new Map(), shown: false, closed: false }
      state.notifications.push(this.entry)
    }
    once(event: string, handler: () => void) {
      this.entry.handlers.set(event, handler)
      return this
    }
    show() {
      this.entry.shown = true
    }
    close() {
      this.entry.closed = true
      this.entry.handlers.get('close')?.()
    }
  },
}))

import { SystemNotices } from '../../src/main/notifications/system-notices'

let now = 0
beforeEach(() => {
  state.supported = true
  state.notifications.length = 0
  now = 0
})
const notice = (key: string, body = 'Finished its turn', onClick = vi.fn()) => ({ key, title: 'Fix login', body, onClick })

describe('SystemNotices', () => {
  it('shows silent notifications with a flat, bounded body', () => {
    const notices = new SystemNotices(() => now)
    notices.show({ ...notice('a', `line one\n\n  line two ${'x'.repeat(400)}`), subtitle: 'Maestrly' })
    const [{ options, shown }] = state.notifications
    expect(shown).toBe(true)
    expect(options).toMatchObject({ title: 'Fix login', subtitle: 'Maestrly', silent: true })
    expect(options.body).toMatch(/^line one line two x+…$/)
    expect((options.body as string).length).toBe(240)
  })

  it('replaces the last notification of a key and skips the same one repeated at once', () => {
    const notices = new SystemNotices(() => now)
    notices.show(notice('a'))
    notices.show(notice('a'))
    expect(state.notifications).toHaveLength(1)
    now = 2_001
    notices.show(notice('a'))
    notices.show(notice('a', 'Has a question for you'))
    notices.show(notice('b'))
    expect(state.notifications.map((item) => item.closed)).toEqual([true, true, false, false])
  })

  it('runs the click and forgets the notification', () => {
    const onClick = vi.fn()
    const notices = new SystemNotices(() => now)
    notices.show(notice('a', 'Finished its turn', onClick))
    state.notifications[0].handlers.get('click')?.()
    expect(onClick).toHaveBeenCalledOnce()
    notices.dismiss('a')
    expect(state.notifications[0].closed).toBe(false)
  })

  it('dismisses by key and by prefix', () => {
    const notices = new SystemNotices(() => now)
    notices.show(notice('bot:s/alex:main'))
    notices.show(notice('bot:s/alex:run-1'))
    notices.show(notice('bot:s/alexa:main'))
    notices.dismissPrefix('bot:s/alex:')
    expect(state.notifications.map((item) => item.closed)).toEqual([true, true, false])
    notices.dismiss('bot:s/alexa:main')
    expect(state.notifications[2].closed).toBe(true)
  })

  it('shows nothing while turned off or unsupported, and turning off closes what is shown', () => {
    const notices = new SystemNotices(() => now)
    notices.show(notice('a'))
    notices.setEnabled(false)
    expect(state.notifications[0].closed).toBe(true)
    notices.show(notice('b'))
    notices.setEnabled(true)
    state.supported = false
    notices.show(notice('c'))
    expect(state.notifications).toHaveLength(1)
  })
})
