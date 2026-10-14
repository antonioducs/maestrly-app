import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ScanSearch } from 'lucide-react'
import { reviewLocksConversation } from '../../../../shared/review'
import { Button } from '@/components/ui/button'
import { useHostApi } from '@/lib/hosts/host-context'
import { formatReviewClock, isReviewRunning, requestCodeReview, useConversationReview } from '@/lib/review'
import { cn } from '@/lib/utils'

/**
 * The header's Review button: opens a code review, and while one is open shows that it is (with its clock while the
 * reviewers work) and brings it back.
 */
export function ReviewHeaderButton({ conversationId, hostId }: { conversationId: string; hostId: string }) {
  const { t } = useTranslation('chat')
  const api = useHostApi()
  const { review } = useConversationReview(api, conversationId)
  const running = isReviewRunning(review) && review?.kind === 'review'
  const open = review?.kind === 'review' && reviewLocksConversation(review)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="review-header-button"
      className={cn(
        'h-7 min-w-0 gap-1.5 px-2 text-[11px]',
        running && 'bg-sky-300/10 text-sky-300 tabular-nums hover:bg-sky-300/15',
        open && !running && 'bg-white/[0.08] text-foreground'
      )}
      onClick={() => requestCodeReview({ conversationId, hostId })}
      title={t(open ? 'review.headerOpenHint' : 'review.headerHint')}
    >
      {running ? (
        <span className="size-[7px] shrink-0 animate-pulse rounded-full bg-sky-300" />
      ) : (
        <ScanSearch className="size-3.5" />
      )}
      <span className="truncate">
        {running && review
          ? t('review.headerRunning', { clock: formatReviewClock(now - review.startedAt) })
          : t('review.headerButton')}
      </span>
    </Button>
  )
}
