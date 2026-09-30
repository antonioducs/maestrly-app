import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { RuntimeAssetInfo } from '../../../shared/runtime-assets'
import { assetProgress, formatBytes } from './runtime-asset-presentation'

const primaryCls =
  'rounded-md bg-indigo-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-indigo-400 disabled:opacity-50'
const secondaryCls =
  'rounded-md border border-white/[0.12] px-2.5 py-1 text-[12px] text-foreground hover:bg-white/[0.05] disabled:opacity-50'

/**
 * Voice-model card shown from the microphone while the whisper-model asset is not ready: explains the one-time
 * download, drives install/cancel/retry/repair through the runtime-asset IPC, and shows progress from
 * runtime-assets:changed (passed in as `info`).
 */
export function DictationModelCard({
  info,
  preparing,
  onInfo,
  onClose,
  boundary,
}: {
  info: RuntimeAssetInfo | null
  preparing: boolean
  /** Receives the final snapshot an operation returns, in case the throttled change event lags behind. */
  onInfo: (info: RuntimeAssetInfo) => void
  onClose: () => void
  /** Clicks inside this element (the microphone control) do not close the card. */
  boundary?: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation('chat')
  const cardRef = useRef<HTMLDivElement>(null)
  const [requesting, setRequesting] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onDoc = (e: MouseEvent) => {
      const inside = (boundary?.current ?? cardRef.current)?.contains(e.target as Node)
      if (!inside) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDoc)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [boundary, onClose])

  const run = (operation: () => Promise<RuntimeAssetInfo | boolean>) => {
    setRequesting(true)
    void operation()
      .then((result) => {
        if (typeof result !== 'boolean') onInfo(result)
      })
      .catch((error: unknown) => console.error('[mic] voice model operation failed', error))
      .finally(() => setRequesting(false))
  }
  const install = () => run(() => window.api.runtimeAssetInstall('whisper-model'))
  const cancel = () => run(() => window.api.runtimeAssetCancel('whisper-model'))
  const repair = () => run(() => window.api.runtimeAssetRepair('whisper-model'))

  // The service reports a user cancel as `failed` with a "cancelled" message; offer a plain Download again.
  const cancelled = info?.status.state === 'failed' && /cancel/i.test(info.status.error ?? '')
  const state = cancelled ? 'not-installed' : info?.status.state
  const size = formatBytes(info?.downloadBytes ?? 0)
  const progress = info ? assetProgress(info) : 0

  let body: React.ReactNode
  if (!info) {
    body = <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
  } else if (state === 'downloading') {
    body = (
      <>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]">
          <div className="h-full bg-indigo-500 transition-[width]" style={{ width: `${progress}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-[12px] text-muted-foreground">
            {t('mic.modelDownloading', {
              // formatBytes renders 0 as a dash, which reads oddly at the start of a download.
              done: info.status.bytesDownloaded ? formatBytes(info.status.bytesDownloaded) : '0 B',
              total: formatBytes(info.status.totalBytes || info.downloadBytes),
            })}
          </span>
          <button type="button" onClick={cancel} className={secondaryCls}>
            {t('mic.modelCancel')}
          </button>
        </div>
      </>
    )
  } else if (state === 'verifying' || state === 'installing' || state === 'removing') {
    body = (
      <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {state === 'verifying'
          ? t('mic.modelVerifying')
          : state === 'installing'
            ? t('mic.modelInstalling')
            : t('settings.componentState_removing')}
      </span>
    )
  } else if (state === 'ready') {
    body = (
      <span className="flex items-center gap-2 text-[12px] text-muted-foreground">
        {preparing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {preparing ? t('mic.modelPreparing') : t('mic.modelReady')}
      </span>
    )
  } else if (state === 'failed') {
    body = (
      <>
        <p className="text-[12px] text-amber-400">{t('mic.modelFailed')}</p>
        {info.status.error && <p className="mt-0.5 text-[11px] text-muted-foreground">{info.status.error}</p>}
        <div className="mt-2 flex justify-end">
          <button type="button" onClick={install} disabled={requesting} className={primaryCls}>
            {t('mic.modelRetry')}
          </button>
        </div>
      </>
    )
  } else if (state === 'corrupt') {
    body = (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-amber-400">{t('settings.componentState_corrupt')}</span>
        <button type="button" onClick={repair} disabled={requesting} className={primaryCls}>
          {t('mic.modelRepair')}
        </button>
      </div>
    )
  } else {
    body = (
      <div className="flex justify-end">
        <button type="button" onClick={install} disabled={requesting} className={primaryCls}>
          {t('mic.modelDownload')}
        </button>
      </div>
    )
  }

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={t('mic.modelTitle')}
      className="absolute bottom-full right-0 z-50 mb-1 w-80 overflow-hidden rounded-lg border border-white/[0.1] bg-[#161618] p-3 shadow-2xl"
    >
      <p className="text-[13px] font-medium text-foreground">{t('mic.modelTitle')}</p>
      <p className="mb-2.5 mt-1 text-[12px] leading-snug text-muted-foreground">{t('mic.modelBody', { size })}</p>
      {body}
    </div>
  )
}
