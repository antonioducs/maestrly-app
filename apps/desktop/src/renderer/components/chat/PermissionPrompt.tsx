import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { ChatPermissionRequest } from '../../../shared/chat'

interface Props {
  request: ChatPermissionRequest
  onDecide: (reply: 'once' | 'always' | 'reject') => void
}

export function PermissionPrompt({ request, onDecide }: Props) {
  const { t } = useTranslation('chat')
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-amber-200">{request.title}</p>
            {request.resources.length > 0 && (
              <p className="mt-0.5 truncate font-mono text-[11px] text-amber-200/70">{request.resources.join('  ')}</p>
            )}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => onDecide('once')}
                className="rounded-md bg-amber-500 px-2.5 py-1 text-[12px] font-medium text-black hover:bg-amber-400"
              >
                {t('permPrompt.allowOnce')}
              </button>
              {request.allowAlways && (
                <button
                  type="button"
                  onClick={() => onDecide('always')}
                  className="rounded-md border border-amber-500/50 px-2.5 py-1 text-[12px] font-medium text-amber-200 hover:bg-amber-500/15"
                >
                  {t('permPrompt.allowAlways')}
                </button>
              )}
              <button
                type="button"
                onClick={() => onDecide('reject')}
                className="rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-muted-foreground hover:bg-white/5"
              >
                {t('permPrompt.deny')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
