import type { FleetBot } from '@maestrly/bot-fleet-protocol'
import { useCallback, useMemo } from 'react'
import { ActivityIndicator, FlatList, View } from 'react-native'
import type { OutboxEntry } from '../../fleet/outbox'
import { useFleet, useFleetController } from '../../fleet/react'
import type { FleetState } from '../../fleet/state'
import { transcriptRows, type TranscriptRow } from '../../fleet/transcript-rows'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { OutboxRow } from '../composer/OutboxRow'
import { AppText } from '../primitives/Text'
import { AssistantMarkdown } from './AssistantMarkdown'
import { HelpCard } from './HelpCard'
import { PermissionCard } from './PermissionCard'
import { QuestionCard } from './QuestionCard'
import { ReasoningBlock } from './ReasoningBlock'
import { SystemLine } from './SystemLine'
import { TodoCard } from './TodoCard'
import { ToolGroup } from './ToolGroup'
import { UserBubble } from './UserBubble'

type Row = TranscriptRow | { kind: 'outbox'; entry: OutboxEntry }
const rowKey = (row: Row) =>
  row.kind === 'item' ? row.item.id : row.kind === 'outbox' ? `outbox:${row.entry.id}` : `${row.kind}:${row.id}`

function RowView({ row }: { row: Row }) {
  switch (row.kind) {
    case 'outbox':
      return <OutboxRow entry={row.entry} />
    case 'tools':
      return <ToolGroup tools={row.tools} />
    case 'todos':
      return <TodoCard todos={row.todos} />
    default: {
      const item = row.item
      switch (item.kind) {
        case 'user':
          return <UserBubble item={item} />
        case 'assistant':
          return <AssistantMarkdown text={item.text} streaming={item.streaming} />
        case 'reasoning':
          return <ReasoningBlock item={item} />
        case 'permission':
          return <PermissionCard item={item} />
        case 'question':
          return <QuestionCard item={item} />
        case 'help':
          return <HelpCard item={item} />
        case 'tool':
          return <ToolGroup tools={[item]} />
        default:
          return <SystemLine item={item} />
      }
    }
  }
}

/** The conversation with a bot, newest at the bottom; scrolling up loads older pages. */
export function Transcript({ bot }: { bot: FleetBot }) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const controller = useFleetController()
  const transcript = useFleet(useCallback((state: FleetState) => state.transcripts[bot.id], [bot.id]))
  const outbox = useFleet(useCallback((state: FleetState) => state.outbox.filter((entry) => entry.botId === bot.id), [bot.id]))
  const data = useMemo<Row[]>(() => {
    const rows: Row[] = transcriptRows(transcript?.items ?? [])
    for (const entry of outbox) rows.push({ kind: 'outbox', entry })
    // The list is inverted so it starts at the newest message, so it takes the rows newest first.
    return rows.reverse()
  }, [transcript?.items, outbox])
  const thinking =
    bot.status === 'working' &&
    bot.activity?.kind === 'thinking' &&
    !transcript?.items.some((item) => (item.kind === 'assistant' || item.kind === 'reasoning') && item.streaming)

  if (!transcript?.loaded)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} />
      </View>
    )
  if (data.length === 0)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <AppText tone="muted" style={{ textAlign: 'center' }}>
          {t('conv.empty', { name: bot.name })}
        </AppText>
      </View>
    )
  return (
    <FlatList
      inverted
      data={data}
      keyExtractor={rowKey}
      renderItem={({ item }) => <RowView row={item} />}
      ItemSeparatorComponent={() => <View style={{ height: 14 }} />}
      contentContainerStyle={{ paddingHorizontal: 18, paddingVertical: 10 }}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      onEndReached={() => void controller.loadOlder(bot.id)}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        thinking ? (
          <AppText variant="sub" tone="faint" style={{ fontSize: 15, marginTop: 14 }} accessibilityLiveRegion="polite">
            {t('status.thinking')}
          </AppText>
        ) : null
      }
      ListFooterComponent={
        transcript.loading && transcript.before ? (
          <ActivityIndicator color={palette.muted} style={{ marginBottom: 14 }} />
        ) : null
      }
    />
  )
}
