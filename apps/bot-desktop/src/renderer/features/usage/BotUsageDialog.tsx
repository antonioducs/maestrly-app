import { QuickUsageDialog, QuickUsageRefresh, QuickUsageTargets, UsagePanel, useChatUi } from '@maestrly/chat-ui'
import type { Bot } from '@maestrly/host-protocol'
import { useT } from '../../i18n'
import { useUsage } from './useUsage'

/** The `$` of a conversation: this bot's usage over the last 30 days, in the shared dialog. */
export function BotUsageDialog({ bot, open, onOpenChange, connected, supported }: { bot: Bot; open: boolean; onOpenChange: (open: boolean) => void; connected: boolean; supported: boolean }) {
  const t = useT()
  const { labels } = useChatUi()
  const usage = useUsage(open ? bot.id : undefined, open && connected, supported, labels.usage.turnsUnit)
  return (
    <QuickUsageDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('usageOf').replace('{name}', bot.name)}
      description={labels.usage.description}
      footer={<QuickUsageRefresh loading={usage.loading} onRefresh={usage.reload} label={labels.usage.refresh} />}
    >
      <QuickUsageTargets
        targets={[{ key: bot.id, label: bot.name, data: { 'quick-usage-bot': bot.id } }]}
        render={() => (
          <UsagePanel
            heading={<span />}
            rows={usage.rows}
            turns={usage.summary?.turns ?? 0}
            firstAt={usage.summary?.firstAt ? Date.parse(usage.summary.firstAt) : null}
            lastAt={usage.summary?.lastAt ? Date.parse(usage.summary.lastAt) : null}
            loading={usage.loading}
            period={usage.period}
            onPeriodChange={usage.setPeriod}
            custom={usage.custom}
            onCustomChange={usage.setCustom}
            minCustomDay={usage.minCustomDay}
            onRefresh={usage.reload}
          />
        )}
      />
      {usage.error && <p role="alert">{usage.error}</p>}
    </QuickUsageDialog>
  )
}
