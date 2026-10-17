import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { ChatPermissionRequest } from '../../../shared/chat'
import { permissionExtraResources } from '../../../shared/permission-preview'

interface Props {
  scope?: 'project' | 'standalone'
  request: ChatPermissionRequest
  onDecide: (reply: 'once' | 'always' | 'reject') => void
}

export function PermissionPrompt({ request, onDecide, scope = 'project' }: Props) {
  const { t } = useTranslation('chat')
  const resources = permissionExtraResources(request)
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-2">
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <p className="break-words text-[13px] font-medium text-amber-200">{request.title}</p>
            {request.preview && (
              <pre
                data-testid="permission-preview"
                className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 px-2 py-1.5 font-mono text-[11px] leading-[1.45] text-amber-100/90"
              >
                {request.preview}
              </pre>
            )}
            {resources.length > 0 && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-amber-200/70">
                {resources.join('\n')}
              </pre>
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
                  {t(scope === 'standalone' ? 'permPrompt.allowAlwaysChat' : 'permPrompt.allowAlways')}
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
