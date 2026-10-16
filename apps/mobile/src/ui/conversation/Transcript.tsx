import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { useCallback, useMemo } from 'react'
import { useFleet, useFleetController } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { OutboxRow } from '../composer/OutboxRow'
import { ConversationList, type ExtraRow } from './ConversationList'

/** The conversation with a bot, newest at the bottom; scrolling up loads older pages. */
export function Transcript({ bot }: { bot: FleetBot }) {
  const { t } = useI18n()
  const controller = useFleetController()
  const transcript = useFleet(useCallback((state: FleetState) => state.transcripts[bot.id], [bot.id]))
  const outbox = useFleet(
    useCallback((state: FleetState) => state.outbox.filter((entry) => entry.botId === bot.id), [bot.id])
  )
  const extras = useMemo<ExtraRow[]>(
    () =>
      outbox.map((entry) => ({
        key: entry.id,
        node: (
          <OutboxRow
            entry={entry}
            waitingText={t('outbox.waiting')}
            failedReason={t(`outbox.error.${entry.error ?? 'generic'}`)}
            onRetry={() => void controller.retryOutbox(entry.id)}
            onDelete={() => void controller.deleteOutbox(entry.id)}
          />
        ),
      })),
    [outbox, controller, t]
  )
  const items = transcript?.items ?? []
  const thinking =
    bot.status === 'working' &&
    bot.activity?.kind === 'thinking' &&
    !items.some((item) => (item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming)

  return (
    <ConversationList
      items={items}
      extras={extras}
      loaded={!!transcript?.loaded}
      loadingOlder={!!transcript?.loading && !!transcript.before}
      thinking={thinking}
      emptyText={t('conv.empty', { name: bot.name })}
      onLoadOlder={() => void controller.loadOlder(bot.id)}
      hasOlder={!!transcript?.before}
    />
  )
}
