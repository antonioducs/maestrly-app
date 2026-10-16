import type { MobileChatItem } from '@maestrly/bot-fleet-protocol'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, FlatList, Pressable, View } from 'react-native'
import { transcriptRows, type TranscriptRow } from '../../fleet/transcript-rows'
import { useI18n } from '../../i18n'
import { useTheme } from '../../theme/ThemeProvider'
import { Icon } from '../icons'
import { AppText } from '../primitives/Text'
import { useReducedMotion } from '../useReducedMotion'
import { ArtifactCard } from './ArtifactCard'
import { AssistantMarkdown } from './AssistantMarkdown'
import { BotFiles } from './BotFiles'
import { DispatchCard } from './DispatchCard'
import { HelpCard } from './HelpCard'
import { PermissionCard } from './PermissionCard'
import { QuestionCard } from './QuestionCard'
import { ReasoningBlock } from './ReasoningBlock'
import { SystemLine } from './SystemLine'
import { TodoCard } from './TodoCard'
import { ToolGroup } from './ToolGroup'
import { shouldOfferScrollToEnd } from './scroll-to-end'
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
    case 'files':
      return <BotFiles files={row.files} />
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
  const reduced = useReducedMotion()
  const list = useRef<FlatList<Row>>(null)
  const viewport = useRef(0)
  const [away, setAway] = useState(false)
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
    <View style={{ flex: 1 }}>
      <FlatList
        ref={list}
        inverted
        data={data}
        onLayout={(event) => {
          viewport.current = event.nativeEvent.layout.height
        }}
        onScroll={(event) => {
          const next = shouldOfferScrollToEnd(event.nativeEvent.contentOffset.y, viewport.current)
          setAway((current) => (current === next ? current : next))
        }}
        scrollEventThrottle={64}
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
            <AppText
              variant="sub"
              tone="faint"
              style={{ fontSize: 15, marginTop: 14 }}
              accessibilityLiveRegion="polite"
            >
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
      {away ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('conv.scrollToEnd')}
          onPress={() => list.current?.scrollToOffset({ offset: 0, animated: !reduced })}
          style={({ pressed }) => ({
            position: 'absolute',
            bottom: 10,
            alignSelf: 'center',
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: palette.line,
            backgroundColor: palette.raised,
            shadowColor: '#000',
            shadowOpacity: 0.18,
            shadowRadius: 8,
            shadowOffset: { width: 0, height: 2 },
            elevation: 3,
            transform: [{ scale: pressed ? 0.94 : 1 }],
          })}
        >
          <Icon name="arrow-down" size={20} color={palette.ink} />
        </Pressable>
      ) : null}
    </View>
  )
}
