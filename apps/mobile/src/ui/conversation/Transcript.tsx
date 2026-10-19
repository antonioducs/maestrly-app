import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { useCallback, useMemo } from 'react'
import { runMarkers, runSettingsOf } from '../../fleet/lanes'
import { useFleet, useFleetController } from '../../fleet/react'
import { botWorksHere } from '../../fleet/selectors'
import type { FleetState } from '../../fleet/state'
import { useI18n } from '../../i18n'
import { OutboxRow } from '../composer/OutboxRow'
import { RunMarker } from '../lanes/RunMarker'
import { ConversationList, type ExtraRow } from './ConversationList'
import { useConversation } from './CueCard'

/**
 * The conversation with a bot, newest at the bottom; scrolling up loads older pages. Where the bot keeps its routine
 * runs apart, those that ended show where they ended, as its settings say.
 */
export function Transcript({ bot }: { bot: FleetBot }) {
  const { t } = useI18n()
  const controller = useFleetController()
  const { lanes } = useConversation()
  const transcript = useFleet(useCallback((state: FleetState) => state.transcripts[bot.id], [bot.id]))
  const outbox = useFleet(
    useCallback((state: FleetState) => state.outbox.filter((entry) => entry.botId === bot.id), [bot.id])
  )
  const runs = useFleet(useCallback((state: FleetState) => state.runs[bot.id]?.runs ?? null, [bot.id]))
  const settings = runSettingsOf(bot)
  const items = transcript?.items ?? []
  // Before the oldest item loaded only once the whole conversation is.
  const oldest = transcript?.before ? (items[0]?.at ?? null) : ''
  const markers = useMemo<ExtraRow[]>(() => {
    if (!lanes?.runs || !runs || oldest === null) return []
    return runMarkers(runs, settings)
      .filter((run) => (run.finishedAt ?? run.deliveredAt) >= oldest)
      .map((run) => ({
        key: `run:${run.id}`,
        at: run.finishedAt ?? run.deliveredAt,
        node: <RunMarker run={run} onOpen={() => lanes.openRun(run.id)} onCite={() => lanes.cite(run)} />,
      }))
  }, [lanes, runs, settings, oldest])
  const extras = useMemo<ExtraRow[]>(
    () => [
      ...markers,
      ...outbox.map((entry) => ({
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
    ],
    [markers, outbox, controller, t]
  )
  const thinking =
    botWorksHere(bot) &&
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
