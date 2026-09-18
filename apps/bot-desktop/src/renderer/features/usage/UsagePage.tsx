import { ArrowLeft, DollarSign } from 'lucide-react'
import { ChatTopBar, SettingsContent, UsagePanel, fmtCost, fmtTokens, useChatUi } from '@maestrly/chat-ui'
import { Button } from '../../ui'
import { useT } from '../../i18n'
import { useUsage } from './useUsage'

/** Usage of every bot on the connected Host: the shared table by model, then a breakdown by bot. */
export function UsagePage({
  connected,
  supported,
  onBack,
}: {
  connected: boolean
  supported: boolean
  onBack: () => void
}) {
  const t = useT()
  const { labels } = useChatUi()
  const usage = useUsage(undefined, connected, supported, labels.usage.turnsUnit)
  const costOf = (botId: string) => {
    // A bot's share of the priced total, in proportion to its tokens: the ledger prices by model, not by bot.
    const priced = usage.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0)
    const total = usage.summary ? usage.summary.input + usage.summary.output : 0
    const bot = usage.summary?.byBot.find((row) => row.botId === botId)
    return bot && total > 0 && priced > 0 ? (priced * (bot.input + bot.output)) / total : null
  }
  return (
    <div className="usage-view">
      <ChatTopBar
        className="usage-header"
        leading={
          <div className="flex min-w-0 items-center gap-2">
            <DollarSign className="size-4 text-muted-foreground" aria-hidden="true" />
            <h1 className="truncate text-[13px] font-medium text-foreground/90">{t('usage')}</h1>
          </div>
        }
        trailing={
          <Button className="topbar-icon" aria-label={t('back')} title={t('back')} onClick={onBack}>
            <ArrowLeft size={15} aria-hidden="true" />
          </Button>
        }
      />
      <div className="usage-scroll">
        <SettingsContent className="usage-page">
          {connected && !supported && <p role="status">{t('usageHostOutdated')}</p>}
          {!connected && <p>{t('connectionReason')}</p>}
          {connected && supported && (
            <>
              <UsagePanel
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
              {!!usage.summary?.byBot.length && (
                <section className="usage-by-bot" aria-label={t('usageByBot')}>
                  <h2>{t('usageByBot')}</h2>
                  <ul>
                    {usage.summary.byBot.map((row) => {
                      const cost = costOf(row.botId)
                      return (
                        <li key={row.botId} className="extension-row">
                          <div>
                            <strong>{row.name || row.botId}</strong>
                            <small className="muted">
                              {' '}
                              · {row.turns} {labels.usage.turnsUnit} · {fmtTokens(row.input + row.output)} tokens
                            </small>
                          </div>
                          <span>{cost == null ? labels.usage.dash : `~${fmtCost(cost)}`}</span>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}
            </>
          )}
          {usage.error && <p role="alert">{usage.error}</p>}
        </SettingsContent>
      </div>
    </div>
  )
}
