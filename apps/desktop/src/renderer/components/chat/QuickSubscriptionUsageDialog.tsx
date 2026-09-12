import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatSubscriptionUsage } from '../../../shared/chat'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SubscriptionUsagePanel } from './SubscriptionUsagePanel'
import type { QuickUsageTarget } from './quick-subscription-usage'

function targetKey(target: QuickUsageTarget): string {
  return target.providerId
}

export function QuickSubscriptionUsageDialog({
  open,
  onOpenChange,
  targets,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  targets: QuickUsageTarget[]
}) {
  const { t } = useTranslation('ui')
  const [snapshots, setSnapshots] = useState<Record<string, ChatSubscriptionUsage>>({})
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)

  const load = useCallback(
    async (force: boolean) => {
      const request = ++requestRef.current
      setLoading(true)
      const entries = await Promise.all(
        targets.map(async (target): Promise<[string, ChatSubscriptionUsage]> => {
          try {
            const usage = await window.api.chatSubscriptionUsage(target.providerKind, force, target.accountId)
            return [targetKey(target), usage]
          } catch (error) {
            return [
              targetKey(target),
              {
                state: 'error',
                providerKind: target.providerKind,
                accountId: target.accountId,
                error: error instanceof Error ? error.message : String(error),
              },
            ]
          }
        })
      )
      if (request !== requestRef.current) return
      setSnapshots(Object.fromEntries(entries))
      setLoading(false)
    },
    [targets]
  )

  useEffect(() => {
    if (!open) return
    void load(false)
  }, [load, open])

  useEffect(() => {
    if (open) return
    requestRef.current += 1
    setLoading(false)
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[min(520px,calc(100vh-2rem))] max-w-xl flex-col gap-4 overflow-hidden"
        closeLabel={t('common.close')}
        data-testid="quick-usage-dialog"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Activity className="size-4 text-emerald-400" />
            {t('sidebar.usageTitle')}
          </DialogTitle>
          <DialogDescription>{t('sidebar.usageDescription')}</DialogDescription>
        </DialogHeader>

        <div
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1"
          data-testid="quick-usage-list"
        >
          {targets.map((target) => {
            const usage = snapshots[targetKey(target)] ?? null
            return (
              <section
                key={targetKey(target)}
                className="rounded-lg border border-border bg-black/15 px-3 py-3"
                data-quick-usage-provider={target.providerKind}
                data-quick-usage-account={target.accountId ?? 'default'}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground">{target.label}</p>
                    {target.accountLabel && !target.label.includes(target.accountLabel) && (
                      <p className="truncate text-[11px] text-muted-foreground">{target.accountLabel}</p>
                    )}
                  </div>
                </div>
                {usage?.state === 'unsupported' ? (
                  <p className="mt-2 text-[11px] text-muted-foreground">{t('sidebar.usageUnavailable')}</p>
                ) : (
                  <SubscriptionUsagePanel usage={usage} loading={loading && !usage} showHeading={false} />
                )}
              </section>
            )
          })}
        </div>

        <div className="flex shrink-0 justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-[12px]"
            disabled={loading}
            onClick={() => void load(true)}
            aria-label={t('sidebar.usageRefresh')}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {t('common.refresh')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
