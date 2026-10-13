import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface HookNoticeItem {
  id: number
  plugin: string
  event: string
  text: string
  level: 'info' | 'error'
}

/** Start of a send error for a prompt a plugin's UserPromptSubmit hook blocked; the reason follows. */
export const BLOCKED_BY_HOOK = 'blocked-by-hook: '

/** Info notices leave on their own; failures stay until dismissed. */
export const HOOK_NOTICE_INFO_MS = 8_000
const MAX_NOTICES = 3

/** Keeps the latest notices only: a chatty hook must not push the composer off the screen. */
export function addHookNotice(notices: readonly HookNoticeItem[], notice: HookNoticeItem): HookNoticeItem[] {
  return [...notices, notice].slice(-MAX_NOTICES)
}

/** Messages and failures of the conversation's plugin hooks, shown above the composer and never stored. */
export function HookNotices({
  notices,
  onDismiss,
}: {
  notices: readonly HookNoticeItem[]
  onDismiss: (id: number) => void
}) {
  const { t } = useTranslation('chat')
  if (!notices.length) return null
  return (
    <div className="mx-auto mb-1.5 flex w-full max-w-3xl flex-col gap-1 px-1" data-testid="hook-notices">
      {notices.map((notice) => (
        <div
          key={notice.id}
          role={notice.level === 'error' ? 'alert' : 'status'}
          className={
            notice.level === 'error'
              ? 'flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/[0.08] px-3 py-1.5 text-[12px] text-amber-100'
              : 'flex items-start gap-2 rounded-lg border border-sky-500/25 bg-sky-500/[0.08] px-3 py-1.5 text-[12px] text-sky-100'
          }
        >
          <span className="shrink-0 font-medium">
            {t('hookNotice.source', { plugin: notice.plugin, event: notice.event })}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{notice.text}</span>
          <button
            type="button"
            onClick={() => onDismiss(notice.id)}
            className="rounded p-0.5 opacity-80 hover:opacity-100"
            aria-label={t('view.dismiss')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
