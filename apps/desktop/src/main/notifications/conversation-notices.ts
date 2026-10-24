import { tMain } from '../i18n'
import type { SystemNotice } from './system-notices'

export type ConversationNoticeKind = 'finished' | 'failed' | 'question' | 'plan'

export interface ConversationNoticesDeps {
  notices: { show(notice: SystemNotice): void; dismiss(key: string): void }
  /** Whether the owner looks at this conversation now. */
  sees(conversationId: string): boolean
  /** Its name and project; null when it is not known here (deleted, or a remote one not listed yet). */
  label(conversationId: string): { name: string; projectName?: string } | null
  open(conversationId: string): void
}

const noticeKey = (conversationId: string) => `conversation:${conversationId}`

/**
 * System notifications of conversations, this computer's or a remote host's (by host key): a turn that ended or
 * failed, a question, a plan, while the owner looks elsewhere. A newer one replaces the conversation's last, and
 * seeing the conversation removes it.
 */
export class ConversationNotices {
  /** Conversations whose current turn brought a plan: that turn ends without another notice. */
  private readonly planned = new Set<string>()

  constructor(private readonly deps: ConversationNoticesDeps) {}

  /**
   * A status the conversation's registry emitted, which emits ready and error only when a turn ends, and asking once
   * per question. `alert` is false for a status that needs no one, such as the end of a compaction. Returns what it
   * tells the owner, shown or not, so that a host's conversation can sound it.
   */
  status(conversationId: string, status: string, alert = true): ConversationNoticeKind | null {
    if (status === 'working') {
      this.planned.delete(conversationId)
      return null
    }
    if (status === 'ready' && this.planned.delete(conversationId)) return null
    if (!alert) return null
    const kind: ConversationNoticeKind | null =
      status === 'ready' ? 'finished' : status === 'error' ? 'failed' : status === 'asking' ? 'question' : null
    if (kind) this.notify(conversationId, kind)
    return kind
  }

  plan(conversationId: string): ConversationNoticeKind {
    this.planned.add(conversationId)
    this.notify(conversationId, 'plan')
    return 'plan'
  }

  /** The owner saw the conversation: its mark was cleared. */
  seen(conversationId: string): void {
    this.deps.notices.dismiss(noticeKey(conversationId))
  }

  private notify(conversationId: string, kind: ConversationNoticeKind): void {
    if (this.deps.sees(conversationId)) return
    const t = tMain('main')
    const label = this.deps.label(conversationId)
    this.deps.notices.show({
      key: noticeKey(conversationId),
      title: label?.name || t('notices.untitled'),
      ...(label?.projectName ? { subtitle: label.projectName } : {}),
      body: t(`notices.${kind}`),
      onClick: () => this.deps.open(conversationId),
    })
  }
}
