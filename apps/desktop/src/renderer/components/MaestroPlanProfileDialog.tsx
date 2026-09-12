import { useEffect, useMemo, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MaestroStrategyProfileCatalog } from '../../shared/maestro'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SearchSelect } from '@/components/ui/search-select'
import {
  maestroStrategyProfileLabel,
  maestroStrategyProfileOptions,
  maestroStrategyProfileSummary,
} from '@/lib/maestro-strategy-profiles'

interface Props {
  open: boolean
  busy: boolean
  decisionError: string | null
  onOpenChange(open: boolean): void
  onConfirm(profileId: string): Promise<boolean>
}

export function MaestroPlanProfileDialog({ open, busy, decisionError, onOpenChange, onConfirm }: Props) {
  const { t } = useTranslation('chat')
  const [catalog, setCatalog] = useState<MaestroStrategyProfileCatalog | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    setCatalog(null)
    setSelectedId('')
    setLoadError(null)
    void window.api
      .chatMaestroStrategyProfilesList()
      .then((next) => {
        if (!alive) return
        setCatalog(next)
        setSelectedId(next.lastUsedId)
      })
      .catch((error) => alive && setLoadError(error instanceof Error ? error.message : String(error)))
    return () => {
      alive = false
    }
  }, [open])

  const options = useMemo(() => maestroStrategyProfileOptions(catalog?.items ?? [], t), [catalog?.items, t])
  const selected = catalog?.items.find((item) => item.id === selectedId)
  const error = loadError ?? decisionError

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-300" /> {t('maestro.strategyProfiles.handoffTitle')}
          </DialogTitle>
          <DialogDescription>{t('maestro.strategyProfiles.handoffDescription')}</DialogDescription>
        </DialogHeader>

        {!catalog && !loadError ? (
          <div className="flex h-20 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('maestro.strategyProfiles.loading')}
          </div>
        ) : (
          <div className="space-y-3">
            <SearchSelect
              value={selectedId || undefined}
              options={options}
              onChange={(id) => setSelectedId(id ?? '')}
              placeholder={t('maestro.strategyProfiles.select')}
              ariaLabel={t('maestro.strategyProfiles.select')}
              contentClassName="min-w-[28rem]"
            />
            {selected && (
              <div className="rounded-lg border border-border bg-black/20 p-3">
                <p className="text-sm font-medium text-foreground">{maestroStrategyProfileLabel(selected, t)}</p>
                <p className="mt-1 text-xs text-muted-foreground">{maestroStrategyProfileSummary(selected, t)}</p>
                <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                  {selected.config.pool
                    .filter((resource) => resource.enabled)
                    .map((resource) => resource.label)
                    .join(' · ')}
                </p>
              </div>
            )}
            {error && (
              <p role="alert" className="rounded border border-red-500/20 bg-red-500/[0.08] p-2 text-xs text-red-300">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('maestro.strategyProfiles.cancel')}
          </Button>
          <Button
            disabled={busy || !selectedId || !selected?.orchestrator}
            onClick={() => {
              void onConfirm(selectedId).then((ok) => ok && onOpenChange(false))
            }}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('maestro.strategyProfiles.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
