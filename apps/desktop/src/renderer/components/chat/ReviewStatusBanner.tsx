import { useTranslation } from 'react-i18next'
import { Loader2, ScanSearch, X } from 'lucide-react'
import type { ReviewJobInfo } from '../../../shared/review'
import { isReviewRunning, reviewErrorText, reviewProgressText } from '../../lib/review'

/**
 * Above the composer: a code review in progress (with Cancel), a review that failed, or why one could not start.
 * A finished review shows up in the conversation as a report card instead.
 */
export function ReviewStatusBanner({
  review,
  notice,
  onCancel,
  onDismiss,
}: {
  review: ReviewJobInfo | null
  /** Why the last start request was refused. */
  notice: string | null
  onCancel: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation('chat')
  const running = review?.target === 'code' && isReviewRunning(review)
  const failed = review?.target === 'code' && review.status === 'failed'
  if (!running && !failed && !notice) return null

  if (running && review) {
    return (
      <div className="mx-auto mb-1.5 w-full max-w-3xl px-1">
        <div
          role="status"
          data-testid="review-status-banner"
          className="flex items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/[0.08] px-3 py-1.5 text-[12px] text-sky-100"
        >
          <Loader2 className="size-3.5 shrink-0 animate-spin" />
          <span className="shrink-0 font-medium">{t('review.running')}</span>
          <span className="min-w-0 flex-1 truncate text-sky-100/75">{reviewProgressText(t, review)}</span>
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded-md bg-sky-500/15 px-2 py-0.5 font-medium text-sky-50 hover:bg-sky-500/25"
          >
            {t('review.cancel')}
          </button>
        </div>
      </div>
    )
  }

  const message = failed
    ? t('review.failed', { reason: reviewErrorText(t, review?.error) })
    : t('review.startFailed', { reason: reviewErrorText(t, notice ?? undefined) })
  return (
    <div className="mx-auto mb-1.5 w-full max-w-3xl px-1">
      <div
        role="alert"
        data-testid="review-status-banner"
        className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-3 py-1.5 text-[12px] text-amber-100"
      >
        <ScanSearch className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{message}</span>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 text-amber-200/80 hover:text-amber-50"
          aria-label={t('view.dismiss')}
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
