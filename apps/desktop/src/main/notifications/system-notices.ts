import { Notification } from 'electron'

export interface SystemNotice {
  /** One notification per key: a newer one replaces it, and dismissing the key removes it. */
  key: string
  title: string
  /** Shown by macOS only. */
  subtitle?: string
  body: string
  onClick(): void
}

const REPEAT_MS = 2_000
const BODY_MAX = 240

const flat = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > BODY_MAX ? line.slice(0, BODY_MAX - 1) + '…' : line
}

/**
 * The system notifications of conversations and bots. They are silent: the app plays its own alert sounds, which the
 * owner tunes in Settings, for the same events. A notification is kept referenced while shown, since Electron drops
 * the click handler of one nothing references.
 */
export class SystemNotices {
  private readonly shown = new Map<string, { notification: Notification; signature: string; at: number }>()
  private enabled = true

  constructor(private readonly now: () => number = Date.now) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) for (const key of [...this.shown.keys()]) this.dismiss(key)
  }

  show(notice: SystemNotice): void {
    if (!this.enabled || !Notification.isSupported()) return
    const body = flat(notice.body)
    const signature = `${notice.title}\n${notice.subtitle ?? ''}\n${body}`
    const previous = this.shown.get(notice.key)
    // The same event can reach main twice: a host sends a plan to each window of this computer that follows it.
    if (previous && previous.signature === signature && this.now() - previous.at < REPEAT_MS) return
    this.dismiss(notice.key)
    const notification = new Notification({
      title: notice.title,
      ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
      body,
      silent: true,
    })
    const entry = { notification, signature, at: this.now() }
    this.shown.set(notice.key, entry)
    const forget = () => {
      if (this.shown.get(notice.key) === entry) this.shown.delete(notice.key)
    }
    notification.once('close', forget)
    notification.once('click', () => {
      forget()
      notice.onClick()
    })
    notification.show()
  }

  dismiss(key: string): void {
    const entry = this.shown.get(key)
    if (!entry) return
    this.shown.delete(key)
    try {
      entry.notification.close()
    } catch {
      /* The system may have removed it already. */
    }
  }

  dismissPrefix(prefix: string): void {
    for (const key of [...this.shown.keys()]) if (key.startsWith(prefix)) this.dismiss(key)
  }
}
