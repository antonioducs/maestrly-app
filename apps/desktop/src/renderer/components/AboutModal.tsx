import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { AppInfo } from '../../preload'
import { BrandMark } from '@/components/BrandMark'

interface Props {
  open: boolean
  onClose: () => void
}

export function AboutModal({ open, onClose }: Props) {
  const { t } = useTranslation('ui')
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    if (!open) return
    window.api
      .getAppInfo()
      .then(setInfo)
      .catch(() => {})
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('about.title')}
      onClick={onClose}
    >
      <div
        className="relative flex w-full max-w-sm flex-col items-center overflow-hidden rounded-xl border border-border-strong bg-surface-elevated px-6 pb-5 pt-9 text-center shadow-2xl ring-1 ring-black/20"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-2.5 top-2.5 flex items-center rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          aria-label={t('common.close')}
        >
          <X className="size-4" />
        </button>

        <BrandMark variant="lockup" tone="full" className="h-10" aria-label="Maestrly" />

        <p className="mt-4 text-[13px] leading-snug text-muted-foreground">{t('about.tagline')}</p>

        <div className="mt-3 flex items-center justify-center gap-2 text-[12px] text-muted-foreground/80">
          {info && <span>{t('about.version', { version: info.version })}</span>}
          {info && info.channel !== 'prod' && (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-medium uppercase tracking-wide text-foreground/80 ring-1 ring-white/10">
              {info.channel}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
