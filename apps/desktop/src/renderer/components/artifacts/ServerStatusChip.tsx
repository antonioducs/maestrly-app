import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Settings } from 'lucide-react'
import type { ArtifactServerStatus } from '../../../shared/artifacts'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/components/chat/runtime-asset-presentation'
import { cn } from '@/lib/utils'
import { QUOTA_WARNING_RATIO, serverUnavailableReason } from './artifacts-view'

type ChipKey = 'ready' | 'off' | 'unreachable' | 'absent' | 'unsupported' | 'problem'

const DOT: Record<ChipKey, string> = {
  ready: 'bg-status-ready shadow-[0_0_0_3px_rgba(91,214,160,0.14)]',
  off: 'bg-muted-foreground',
  absent: 'bg-muted-foreground',
  unsupported: 'bg-artifact-warn shadow-[0_0_0_3px_rgba(242,180,92,0.14)]',
  unreachable: 'bg-destructive shadow-[0_0_0_3px_rgba(255,122,133,0.14)]',
  problem: 'bg-destructive shadow-[0_0_0_3px_rgba(255,122,133,0.14)]',
}

/** The bot server, where every artifact lives, at a glance; its details, and the way to its settings, open on click. */
export function ServerStatusChip({
  status,
  onOpenSettings,
}: {
  status: ArtifactServerStatus | null
  onOpenSettings: () => void
}) {
  const { t } = useTranslation('ui')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const key: ChipKey = serverUnavailableReason(status) ?? 'ready'
  const label = t(`artifacts.chip.${key}`)

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      chipRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const ready = status?.state === 'ready' ? status : null
  const ratio = ready?.quotaBytes ? Math.min(1, ready.storageBytes / ready.quotaBytes) : 0
  const dot = <span aria-hidden="true" className={cn('size-[7px] shrink-0 rounded-full', DOT[key])} />

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={chipRef}
        type="button"
        data-testid="artifacts-server-chip"
        data-state={key}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('artifacts.chip.label', { state: label })}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 items-center gap-2 rounded-full border border-border-strong bg-white/[0.03] px-2.5 text-xs text-foreground/75 hover:bg-white/[0.07] hover:text-foreground aria-expanded:bg-white/[0.07] aria-expanded:text-foreground"
      >
        {dot}
        <span>
          {t('artifacts.server.title')} · {label}
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          tabIndex={-1}
          aria-label={t('artifacts.server.title')}
          className="absolute right-0 top-[calc(100%+8px)] z-30 w-[300px] rounded-[10px] border border-border-strong bg-popover p-3.5 shadow-2xl outline-none backdrop-blur-xl animate-in fade-in-0"
        >
          <h3 className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-foreground">
            {dot}
            {t('artifacts.server.title')} · {label}
          </h3>
          <p className="mb-3 text-xs text-muted-foreground">{t(`artifacts.pop.${key}`)}</p>
          {ready && (
            <>
              <div className="mb-1 mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden="true">
                <i
                  className={cn(
                    'block h-full rounded-full',
                    ratio >= QUOTA_WARNING_RATIO ? 'bg-artifact-warn' : 'bg-primary'
                  )}
                  style={{ width: `${Math.max(1.5, ratio * 100)}%` }}
                />
              </div>
              <div className="flex justify-between gap-3 py-1.5 text-xs text-muted-foreground">
                <span>{t('artifacts.pop.storage')}</span>
                <b className="font-medium text-foreground">
                  {t('artifacts.pop.storageValue', {
                    used: formatBytes(ready.storageBytes),
                    total: formatBytes(ready.quotaBytes),
                  })}
                </b>
              </div>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => {
              setOpen(false)
              onOpenSettings()
            }}
          >
            <Settings className="size-3.5" /> {t('artifacts.pop.settings')}
          </Button>
        </div>
      )}
    </div>
  )
}
