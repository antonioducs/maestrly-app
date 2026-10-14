import type { MobileChatItem } from '@maestrly/bot-fleet-protocol'
import { useMemo, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, View } from 'react-native'
import { transcriptRows, type TranscriptRow } from '../../fleet/transcript-rows'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { AppText } from '../primitives/Text'
import { ArtifactCard } from './ArtifactCard'
import { AssistantMarkdown } from './AssistantMarkdown'
import { DispatchCard } from './DispatchCard'
import { HelpCard } from './HelpCard'
import { PermissionCard } from './PermissionCard'
import { QuestionCard } from './QuestionCard'
import { ReasoningBlock } from './ReasoningBlock'
import { SystemLine } from './SystemLine'
import { TodoCard } from './TodoCard'
import { ToolGroup } from './ToolGroup'
import { UserBubble } from './UserBubble'

/** A row the conversation adds after its items: a message still on the phone, or a card such as a plan. */
export type ExtraRow = { key: string; node: ReactNode }
type Row = TranscriptRow | { kind: 'extra'; row: ExtraRow }

const rowKey = (row: Row) =>
  row.kind === 'item' ? row.item.id : row.kind === 'extra' ? `extra:${row.row.key}` : `${row.kind}:${row.id}`

function RowView({ row }: { row: Row }) {
  switch (row.kind) {
    case 'extra':
      return <>{row.row.node}</>
    case 'tools':
      return <ToolGroup tools={row.tools} />
    case 'todos':
      return <TodoCard todos={row.todos} />
    case 'artifact':
      return <ArtifactCard artifact={row.artifact} />
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
        case 'dispatch':
          return <DispatchCard item={item} />
        default:
          return <SystemLine item={item} />
      }
    }
  }
}

/**
 * A conversation, newest at the bottom: its items, then what the phone adds after them. Scrolling up loads older
 * pages; `top` sits above the oldest item loaded, such as where a chat came from.
 */
export function ConversationList({
  items,
  extras,
  loaded,
  loadingOlder,
  thinking,
  emptyText,
  onLoadOlder,
  top,
}: {
  items: MobileChatItem[]
  extras: ExtraRow[]
  loaded: boolean
  loadingOlder: boolean
  thinking: boolean
  emptyText: string
  onLoadOlder: () => void
  top?: ReactNode
}) {
  const { palette } = useTheme()
  const { t } = useI18n()
  const data = useMemo<Row[]>(() => {
    const rows: Row[] = transcriptRows(items)
    for (const row of extras) rows.push({ kind: 'extra', row })
    // The list is inverted so it starts at the newest message, so it takes the rows newest first.
    return rows.reverse()
  }, [items, extras])

  if (!loaded)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={palette.muted} accessibilityLabel={t('common.loading')} />
      </View>
    )
  if (data.length === 0 && !top && !thinking)
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
        <AppText tone="muted" style={{ textAlign: 'center' }}>
          {emptyText}
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
      onEndReached={onLoadOlder}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        thinking ? (
          <AppText variant="sub" tone="faint" style={{ fontSize: 15, marginTop: 14 }} accessibilityLiveRegion="polite">
            {t('status.thinking')}
          </AppText>
        ) : null
      }
      ListFooterComponent={
        <View>
          {loadingOlder ? <ActivityIndicator color={palette.muted} style={{ marginBottom: 14 }} /> : null}
          {top ? <View style={{ marginBottom: 14 }}>{top}</View> : null}
        </View>
      }
    />
  )
}
