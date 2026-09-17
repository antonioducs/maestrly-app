import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { QuickUsageRefresh, QuickUsageTargets } from '@maestrly/chat-ui'
import type { ChatSubscriptionUsage } from '../../../shared/chat'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SubscriptionUsagePanel } from './SubscriptionUsagePanel'
import type { QuickUsageTarget } from './quick-subscription-usage'

function targetKey(target: QuickUsageTarget): string {
  return target.providerId
}

/**
 * The quick look at subscription limits from the sidebar. The dialog shell stays the desktop's
 * own primitive; the list of targets and the refresh control are the shared ones.
 */
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

  const views = targets.map((target) => ({
    ...target,
    key: targetKey(target),
    data: { 'quick-usage-provider': target.providerKind, 'quick-usage-account': target.accountId ?? 'default' },
  }))

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

        <QuickUsageTargets
          targets={views}
          render={(target) => {
            const usage = snapshots[target.key] ?? null
            return usage?.state === 'unsupported' ? (
              <p className="mt-2 text-[11px] text-muted-foreground">{t('sidebar.usageUnavailable')}</p>
            ) : (
              <SubscriptionUsagePanel usage={usage} loading={loading && !usage} showHeading={false} />
            )
          }}
        />

        <div className="flex shrink-0 justify-end">
          <QuickUsageRefresh loading={loading} onRefresh={() => void load(true)} label={t('sidebar.usageRefresh')} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
